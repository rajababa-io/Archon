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
    expect(await deploy.isIssuedManualRequest(id, SHA)).toBe(true);
    expect(await deploy.isIssuedManualRequest(id, 'd'.repeat(40))).toBe(false);

    const toggle = await deploy.recordDeployEvent('p1', 'toggle_on', 'you', SHA);
    expect(await deploy.isIssuedManualRequest(toggle, SHA)).toBe(false);
  });
});

describe('setting up a workflow deploy', () => {
  test('creates exactly one row, with Deploy on Merge off and who set it up', async () => {
    const created = await deploy.setUpWorkflowDeploy('p3', 'main', 'deploy', 'you@example.com');
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
    expect(await deploy.setUpWorkflowDeploy('p3', 'dev', 'other', 'someone')).toBeNull();
    expect(await deploy.getProjectDeploy('p3')).toMatchObject({
      branch: 'main',
      workflowName: 'deploy',
    });
    // Including the archon-host row, which set-up must never turn into a workflow.
    expect(await deploy.setUpWorkflowDeploy('p1', 'dev', 'deploy', 'someone')).toBeNull();
    expect((await deploy.getProjectDeploy('p1'))?.method).toBe('archon-host');
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
