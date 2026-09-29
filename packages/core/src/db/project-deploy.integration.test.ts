/**
 * The per-project deploy setting and its event log (#211), against a real
 * SQLite schema — the boolean round-trip and the manual-request check are the
 * two things a mock could not show.
 */
import { describe, test, expect, mock } from 'bun:test';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const deploy = await import('./project-deploy');

await db.query(
  `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ('p1', 'archon', '/src'),
     ('p2', 'skills', '/skills'), ('p3', 'atlas', '/atlas'), ('p4', 'vault', '/vault')`,
  []
);

const SHA = 'c'.repeat(40);

describe('project deploy setting', () => {
  test('a project with no row has no deploy', async () => {
    expect(await deploy.getProjectDeploy('p2')).toBeNull();
  });

  test('the hand-inserted archon-host row reads as before', async () => {
    // No route creates an archon-host row; the live one was inserted by hand.
    await db.query(
      `INSERT INTO remote_agent_project_deploy (codebase_id, method, branch) VALUES ('p1', 'archon-host', 'dev')`,
      []
    );
    expect(await deploy.getProjectDeploy('p1')).toMatchObject({
      method: 'archon-host',
      branch: 'dev',
      deployOnMerge: false,
    });
    expect((await deploy.findProjectDeployByMethod('archon-host'))?.codebaseId).toBe('p1');
  });

  test('a flip is stored, reports what it was before, and is logged with who did it', async () => {
    const on = await deploy.setDeployOnMerge('p1', true, 'you@example.com');
    expect(on?.before).toBe(false);
    expect(on?.after.deployOnMerge).toBe(true);
    expect(on?.after.updatedBy).toBe('you@example.com');

    const off = await deploy.setDeployOnMerge('p1', false, 'you@example.com');
    expect(off?.before).toBe(true);
    expect(off?.after.deployOnMerge).toBe(false);

    const kinds = (await deploy.listDeployEvents('p1')).map(e => e.kind).sort();
    expect(kinds).toEqual(['toggle_off', 'toggle_on']);
  });

  test('flipping a project with no deploy changes nothing', async () => {
    expect(await deploy.setDeployOnMerge('p2', true, 'you')).toBeNull();
    expect(await deploy.listDeployEvents('p2')).toEqual([]);
  });

  test('a method this binary does not know reads as no deploy', async () => {
    await db.query(
      `INSERT INTO remote_agent_project_deploy (codebase_id, method, branch) VALUES ('p2', 'future-method', 'main')`,
      []
    );
    expect(await deploy.getProjectDeploy('p2')).toBeNull();
  });
});

describe('manual requests', () => {
  test('only an id the console issued, for that commit, counts', async () => {
    const id = await deploy.recordDeployEvent('p1', 'deploy_requested', 'you', SHA);
    expect(await deploy.isIssuedManualRequest('p1', id, SHA)).toBe(true);
    expect(await deploy.isIssuedManualRequest('p1', id, 'd'.repeat(40))).toBe(false);

    const toggle = await deploy.recordDeployEvent('p1', 'toggle_on', 'you', SHA);
    expect(await deploy.isIssuedManualRequest('p1', toggle, SHA)).toBe(false);
  });

  test("a press for one project never lets another project's host deploy", async () => {
    const id = await deploy.recordDeployEvent('p1', 'deploy_requested', 'you', SHA);
    expect(await deploy.isIssuedManualRequest('p4', id, SHA)).toBe(false);
  });
});

describe('setting up a workflow deploy', () => {
  test('creates exactly one row, with Deploy on Merge off and who set it up', async () => {
    const created = await deploy.setUpWorkflowDeploy(
      'p3',
      { branch: 'main', productionBranch: null, workflowName: 'deploy' },
      'you@example.com'
    );
    expect(created).toMatchObject({
      codebaseId: 'p3',
      method: 'workflow',
      workflowName: 'deploy',
      branch: 'main',
      deployOnMerge: false,
      updatedBy: 'you@example.com',
    });
    const rows = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM remote_agent_project_deploy WHERE codebase_id = 'p3'`,
      []
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  test('never replaces a deploy the project already has', async () => {
    expect(
      await deploy.setUpWorkflowDeploy(
        'p3',
        { branch: 'dev', productionBranch: null, workflowName: 'other' },
        'someone'
      )
    ).toBeNull();
    expect(await deploy.getProjectDeploy('p3')).toMatchObject({
      branch: 'main',
      workflowName: 'deploy',
    });
    // Including the archon-host row, which set-up must never turn into a workflow.
    expect(
      await deploy.setUpWorkflowDeploy(
        'p1',
        { branch: 'dev', productionBranch: null, workflowName: 'deploy' },
        'someone'
      )
    ).toBeNull();
    expect((await deploy.getProjectDeploy('p1'))?.method).toBe('archon-host');
  });

  test('a production branch round-trips, and settings change it without touching the switch', async () => {
    // p3 was set up above with none.
    expect((await deploy.getProjectDeploy('p3'))?.productionBranch).toBeNull();
    const after = await deploy.updateDeploySettings(
      'p3',
      { branch: 'main', productionBranch: 'production', workflowName: null },
      'you@example.com'
    );
    expect(after).toMatchObject({
      branch: 'main',
      productionBranch: 'production',
      workflowName: 'deploy',
      deployOnMerge: false,
    });
    const cleared = await deploy.updateDeploySettings(
      'p3',
      { branch: 'trunk', productionBranch: null, workflowName: 'ship' },
      'you@example.com'
    );
    expect(cleared).toMatchObject({
      branch: 'trunk',
      productionBranch: null,
      workflowName: 'ship',
    });
    expect(
      await deploy.updateDeploySettings(
        'p2',
        { branch: 'main', productionBranch: null, workflowName: null },
        'you'
      )
    ).toBeNull();
    // Put p3 back for the tests after this one.
    await deploy.updateDeploySettings(
      'p3',
      { branch: 'main', productionBranch: null, workflowName: 'deploy' },
      'you@example.com'
    );
  });

  test('a workflow row that names no workflow reads as no deploy', async () => {
    await db.query(
      `INSERT INTO remote_agent_project_deploy (codebase_id, method, branch) VALUES ('p4', 'workflow', 'main')`,
      []
    );
    expect(await deploy.getProjectDeploy('p4')).toBeNull();
    await db.query(`DELETE FROM remote_agent_project_deploy WHERE codebase_id = 'p4'`, []);
  });

  test('merge deploys are only the workflow rows on that branch with the switch on', async () => {
    expect(await deploy.listMergeDeploysOnBranch('main')).toEqual([]);
    await deploy.setDeployOnMerge('p3', true, 'you@example.com');
    expect((await deploy.listMergeDeploysOnBranch('main')).map(d => d.codebaseId)).toEqual(['p3']);
    expect(await deploy.listMergeDeploysOnBranch('dev')).toEqual([]);
    await deploy.setDeployOnMerge('p3', false, 'you@example.com');
    expect(await deploy.listMergeDeploysOnBranch('main')).toEqual([]);
  });
});

describe('deploy runs', () => {
  async function run(id: string, codebaseId: string, status: string): Promise<void> {
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
       VALUES ($1, 'cli', $2)`,
      [`c-${id}`, `trigger-${id}`]
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_runs (id, conversation_id, codebase_id, workflow_name, user_message, status, completed_at)
       VALUES ($1, $2, $3, 'deploy', '', $4, ${status === 'running' ? 'NULL' : "datetime('now')"})`,
      [id, `c-${id}`, codebaseId, status]
    );
  }

  test("a project reads its own deploy runs with each run's status, and never another's", async () => {
    await run('r1', 'p3', 'completed');
    await deploy.recordDeployRun('p3', 'r1', 'a'.repeat(40));
    await run('r2', 'p3', 'running');
    await deploy.recordDeployRun('p3', 'r2', 'b'.repeat(40));
    await run('r3', 'p2', 'running');
    await deploy.recordDeployRun('p2', 'r3', 'c'.repeat(40));

    const p3 = await deploy.listDeployRuns('p3');
    expect(p3.map(r => [r.runId, r.status]).sort()).toEqual([
      ['r1', 'completed'],
      ['r2', 'running'],
    ]);
    expect(p3.find(r => r.runId === 'r1')?.finishedAt).not.toBeNull();
    expect((await deploy.listDeployRuns('p2')).map(r => r.runId)).toEqual(['r3']);
    expect(await deploy.listDeployRuns('p1')).toEqual([]);
  });
});

describe('deploys that did not start', () => {
  test("a project reads its own not-started deploys with the reason, and never another's", async () => {
    await deploy.recordDeployNotStarted('p3', SHA, 'o/atlas#7', 'The deploy workflow is missing.');
    await deploy.recordDeployNotStarted('p4', SHA, 'o/vault#8', 'A deploy is already running.');

    expect(await deploy.listDeployNotStarted('p3')).toEqual([
      {
        sha: SHA,
        trigger: 'o/atlas#7',
        reason: 'The deploy workflow is missing.',
        at: expect.any(String),
      },
    ]);
    expect((await deploy.listDeployNotStarted('p4')).map(r => r.trigger)).toEqual(['o/vault#8']);
    expect(await deploy.listDeployNotStarted('p1')).toEqual([]);
  });
});

describe('a remote-host deploy (#220)', () => {
  const TOKEN = 'adina-credential';

  test('is found by its credential, and only by it', async () => {
    await db.query(
      `INSERT INTO remote_agent_project_deploy
         (codebase_id, method, branch, deploy_on_merge, remote_url, remote_token_sha256)
       VALUES ('p4', 'remote-host', 'main', 1, 'http://adina:8080/archon/deploy', $1)`,
      [deploy.hashRemoteToken(TOKEN)]
    );
    expect(await deploy.findRemoteDeployByToken(TOKEN)).toMatchObject({
      codebaseId: 'p4',
      method: 'remote-host',
      branch: 'main',
      deployOnMerge: true,
      remoteUrl: 'http://adina:8080/archon/deploy',
    });
    expect(await deploy.findRemoteDeployByToken('someone-else')).toBeNull();
    expect(await deploy.findRemoteDeployByToken('')).toBeNull();
  });

  test('one with no address reads as no deploy', async () => {
    await db.query(
      `UPDATE remote_agent_project_deploy SET remote_url = NULL WHERE codebase_id = 'p4'`,
      []
    );
    expect(await deploy.getProjectDeploy('p4')).toBeNull();
    expect(await deploy.findRemoteDeployByToken(TOKEN)).toBeNull();
    await db.query(
      `UPDATE remote_agent_project_deploy SET remote_url = 'http://adina:8080/archon/deploy' WHERE codebase_id = 'p4'`,
      []
    );
  });

  test("reports come back newest first, and only that project's", async () => {
    await deploy.recordDeployReport('p4', {
      verdict: 'held',
      sha: SHA,
      liveSha: 'a'.repeat(40),
      reason: 'hold:toggle-off',
    });
    await db.query(
      `INSERT INTO remote_agent_deploy_reports (id, codebase_id, verdict, sha, live_sha, created_at)
       VALUES ('r-future', 'p4', 'teleported', $1, $1, datetime('now', '+1 minute'))`,
      [SHA]
    );
    await db.query(
      `INSERT INTO remote_agent_deploy_reports (id, codebase_id, verdict, sha, live_sha, created_at)
       VALUES ('r-ok', 'p4', 'ok', $1, $1, datetime('now', '+2 minutes'))`,
      [SHA]
    );
    const reports = await deploy.listDeployReports('p4');
    // The verdict this binary does not know is skipped, not guessed at.
    expect(reports.map(r => r.verdict)).toEqual(['ok', 'held']);
    expect(reports[1]).toMatchObject({
      sha: SHA,
      liveSha: 'a'.repeat(40),
      reason: 'hold:toggle-off',
    });
    expect(await deploy.listDeployReports('p1')).toEqual([]);
  });
});
