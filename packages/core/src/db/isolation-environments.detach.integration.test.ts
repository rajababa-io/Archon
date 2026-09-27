/**
 * Integration test: destroying an isolation environment detaches the
 * conversations still bound to it, against a REAL bun:sqlite database (#183).
 *
 * A conversation left holding a destroyed env's `working_path` as its `cwd` is
 * stranded on a directory that no longer exists, and anything that spawns a
 * provider there fails ENOENT. The mock-based isolation-environments.test.ts can
 * only assert SQL strings; this proves which rows the detach actually touches.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with isolation-environments.test.ts's
 * fake.
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
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { create, updateStatus } = await import('./isolation-environments');

await db.query(
  `INSERT INTO remote_agent_codebases (id, name, default_cwd, kind)
   VALUES ('cb-1', 'archon', '/repo', 'folder')`,
  []
);

async function seedConversation(
  id: string,
  envId: string | null,
  cwd: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_conversations
       (id, platform_type, platform_conversation_id, codebase_id, isolation_env_id, cwd)
     VALUES ($1, 'web', $1, 'cb-1', $2, $3)`,
    [id, envId, cwd]
  );
}

async function binding(
  id: string
): Promise<{ isolation_env_id: string | null; cwd: string | null }> {
  const result = await db.query<{ isolation_env_id: string | null; cwd: string | null }>(
    'SELECT isolation_env_id, cwd FROM remote_agent_conversations WHERE id = $1',
    [id]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no conversation ${id}`);
  return row;
}

async function seedEnv(workflowId: string, path: string): Promise<string> {
  const env = await create({
    codebase_id: 'cb-1',
    workflow_type: 'thread',
    workflow_id: workflowId,
    working_path: path,
    branch_name: '' as never,
  });
  return env.id;
}

describe('updateStatus(destroyed) — real SQLite behavior (#183)', () => {
  test('a conversation bound to the env loses the reference and the cwd naming it', async () => {
    const envId = await seedEnv('thread-a', '/wt/thread-a');
    await seedConversation('bound', envId, '/wt/thread-a');

    await updateStatus(envId, 'destroyed');

    expect(await binding('bound')).toEqual({ isolation_env_id: null, cwd: null });
  });

  test('a cwd left behind without the reference (stale_cleaned) is cleared too', async () => {
    const envId = await seedEnv('thread-b', '/wt/thread-b');
    await seedConversation('stale', null, '/wt/thread-b');

    await updateStatus(envId, 'destroyed');

    expect(await binding('stale')).toEqual({ isolation_env_id: null, cwd: null });
  });

  test('a bound conversation whose cwd points elsewhere keeps that cwd', async () => {
    const envId = await seedEnv('thread-c', '/wt/thread-c');
    await seedConversation('elsewhere', envId, '/somewhere/else');

    await updateStatus(envId, 'destroyed');

    expect(await binding('elsewhere')).toEqual({ isolation_env_id: null, cwd: '/somewhere/else' });
  });

  test('conversations on other environments are untouched', async () => {
    const doomed = await seedEnv('thread-d', '/wt/thread-d');
    const other = await seedEnv('thread-e', '/wt/thread-e');
    await seedConversation('other', other, '/wt/thread-e');

    await updateStatus(doomed, 'destroyed');

    expect(await binding('other')).toEqual({ isolation_env_id: other, cwd: '/wt/thread-e' });
  });

  test('reactivating an env detaches nothing', async () => {
    const envId = await seedEnv('thread-f', '/wt/thread-f');
    await seedConversation('kept', envId, '/wt/thread-f');

    await updateStatus(envId, 'active');

    expect(await binding('kept')).toEqual({ isolation_env_id: envId, cwd: '/wt/thread-f' });
  });

  test('an unknown env id throws and detaches nothing', async () => {
    await seedConversation('orphan-ref', null, '/wt/nowhere');

    await expect(updateStatus('no-such-env', 'destroyed')).rejects.toThrow(
      "no environment found with id 'no-such-env'"
    );
    expect(await binding('orphan-ref')).toEqual({ isolation_env_id: null, cwd: '/wt/nowhere' });
  });
});
