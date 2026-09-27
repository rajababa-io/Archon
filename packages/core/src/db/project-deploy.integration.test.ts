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
     ('p2', 'skills', '/skills')`,
  []
);

const SHA = 'c'.repeat(40);

describe('project deploy setting', () => {
  test('a project with no row has no deploy', async () => {
    expect(await deploy.getProjectDeploy('p2')).toBeNull();
  });

  test('a new deploy starts with Deploy on Merge off', async () => {
    await deploy.createProjectDeploy('p1', 'archon-host', 'dev');
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
