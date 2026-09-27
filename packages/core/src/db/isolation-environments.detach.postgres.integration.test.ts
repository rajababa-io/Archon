/**
 * Postgres parity for isolation-environments.detach.integration.test.ts (#183):
 * destroying an env detaches the conversations bound to it. The detach compares
 * a UUID column and a TEXT column against one parameter, which SQLite does not
 * type-check and Postgres does — so the query needs proving on both.
 *
 * Skipped unless ARCHON_TEST_PG_URL names a server this test may create and drop
 * a scratch database on.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import type { Pool as PgPool } from 'pg';

// The barrel is fully replaced (no partial merge), so re-export the constants
// the real module graph needs: bundled-schema reads BUNDLED_IS_BINARY.
mock.module('@archon/paths', () => ({
  BUNDLED_IS_BINARY: false,
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const baseUrl = process.env.ARCHON_TEST_PG_URL;
const SCRATCH_DB = 'archon_pg_detach_test';

describe.skipIf(!baseUrl)('updateStatus(destroyed) — real Postgres behavior (#183)', () => {
  let admin: PgPool;
  let db: import('./adapters/postgres').PostgresAdapter;
  let create: typeof import('./isolation-environments').create;
  let updateStatus: typeof import('./isolation-environments').updateStatus;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    admin = new Pool({ connectionString: baseUrl });
    // SCRATCH_DB is a compile-time constant, safe to inline as an identifier.
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    const scratchUrl = new URL(baseUrl!);
    scratchUrl.pathname = `/${SCRATCH_DB}`;

    const { PostgresAdapter, postgresDialect } = await import('./adapters/postgres');
    db = new PostgresAdapter(scratchUrl.toString());

    mock.module('./connection', () => ({
      pool: db,
      getDatabase: () => db,
      getDialect: () => postgresDialect,
      getDatabaseType: () => 'postgresql',
    }));

    ({ create, updateStatus } = await import('./isolation-environments'));
  });

  afterAll(async () => {
    if (admin) {
      await db?.close();
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.end();
    }
  });

  async function seedEnv(
    workflowId: string,
    path: string
  ): Promise<{ id: string; codebaseId: string }> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO remote_agent_codebases (name, default_cwd, kind)
       VALUES ('detach', '/repo', 'folder') RETURNING id`
    );
    const env = await create({
      codebase_id: rows[0].id,
      workflow_type: 'thread',
      workflow_id: workflowId,
      working_path: path,
      branch_name: '' as never,
    });
    return { id: env.id, codebaseId: rows[0].id };
  }

  async function seedConversation(
    platformId: string,
    codebaseId: string,
    envId: string | null,
    cwd: string | null
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO remote_agent_conversations
         (platform_type, platform_conversation_id, codebase_id, isolation_env_id, cwd)
       VALUES ('web', $1, $2, $3, $4) RETURNING id`,
      [platformId, codebaseId, envId, cwd]
    );
    return rows[0].id;
  }

  async function binding(
    id: string
  ): Promise<{ isolation_env_id: string | null; cwd: string | null }> {
    const { rows } = await db.query<{ isolation_env_id: string | null; cwd: string | null }>(
      'SELECT isolation_env_id, cwd FROM remote_agent_conversations WHERE id = $1',
      [id]
    );
    return rows[0];
  }

  test('bound, stale, and elsewhere conversations are detached as on SQLite', async () => {
    const env = await seedEnv('thread-a', '/wt/thread-a');
    const bound = await seedConversation('bound', env.codebaseId, env.id, '/wt/thread-a');
    const stale = await seedConversation('stale', env.codebaseId, null, '/wt/thread-a');
    const elsewhere = await seedConversation('elsewhere', env.codebaseId, env.id, '/else');
    const other = await seedEnv('thread-b', '/wt/thread-b');
    const untouched = await seedConversation(
      'untouched',
      other.codebaseId,
      other.id,
      '/wt/thread-b'
    );

    await updateStatus(env.id, 'destroyed');

    expect(await binding(bound)).toEqual({ isolation_env_id: null, cwd: null });
    expect(await binding(stale)).toEqual({ isolation_env_id: null, cwd: null });
    expect(await binding(elsewhere)).toEqual({ isolation_env_id: null, cwd: '/else' });
    expect(await binding(untouched)).toEqual({ isolation_env_id: other.id, cwd: '/wt/thread-b' });
  });
});
