/**
 * Integration test: session `metadata` against a REAL bun:sqlite database.
 *
 * sessions.test.ts fakes `pool`, so it cannot prove that SQLite hands the JSON
 * `metadata` column back as text. A chat turn reads the worktree its session
 * started in from that column; on SQLite, without the store's parse, the read
 * would silently find nothing.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with sessions.test.ts's fake.
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

const { transitionSession, getActiveSession } = await import('./sessions');

await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'web-1'), ('conv-2', 'web', 'web-2')`,
  []
);

describe('session metadata — real SQLite round trip', () => {
  test('the worktree a session starts in reads back as an object', async () => {
    await transitionSession('conv-1', 'first-message', {
      ai_assistant_type: 'claude',
      metadata: { worktreePath: '/wt/thread-a' },
    });

    const raw = await db.query<{ metadata: unknown }>(
      'SELECT metadata FROM remote_agent_sessions WHERE conversation_id = $1',
      ['conv-1']
    );
    expect(typeof raw.rows[0]?.metadata).toBe('string');

    const session = await getActiveSession('conv-1');
    expect(session?.metadata).toEqual({ worktreePath: '/wt/thread-a' });
  });

  test('a session started outside a worktree records none', async () => {
    await transitionSession('conv-2', 'first-message', { ai_assistant_type: 'claude' });

    const session = await getActiveSession('conv-2');
    expect(session?.metadata).toEqual({});
  });
});
