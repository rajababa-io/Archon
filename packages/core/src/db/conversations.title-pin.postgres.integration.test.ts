/**
 * Integration test: the title-pin rule against a REAL Postgres server.
 *
 * An automatic title write carries its own pin check (`title_pinned IS NOT
 * TRUE`) so a rename that lands mid-generation cannot be overwritten. The
 * SQLite sibling (`services/title-generator.pin-race.integration.test.ts`)
 * proves the race end to end; this proves the same statement means the same
 * thing where the column is a real BOOLEAN and pre-feature rows hold NULL.
 *
 * Opt-in via ARCHON_TEST_PG_URL (postgres://user:pass@host:port/db). The test
 * creates and drops its own scratch database; the database named in the URL is
 * only used to reach the server.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import type { Pool as PgPool } from 'pg';

// The real @archon/paths with only the logger silenced: conversations.ts reaches
// exports a hand-listed replacement would have to restate.
const paths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...paths,
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
const SCRATCH_DB = 'archon_conversation_title_pin_test';

describe.skipIf(!baseUrl)('updateConversationTitle — real Postgres behavior', () => {
  let admin: PgPool;
  let db: import('./adapters/postgres').PostgresAdapter;
  let conversations: typeof import('./conversations');

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

    conversations = await import('./conversations');
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.end();
    }
  });

  async function insertChat(key: string, pinned: boolean | null): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, title, title_pinned)
       VALUES ('web', $1, 'Original', $2) RETURNING id`,
      [key, pinned]
    );
    return result.rows[0].id;
  }

  async function row(id: string): Promise<{ title: string | null; pinned: boolean | null }> {
    const c = await conversations.getConversationById(id);
    return { title: c?.title ?? null, pinned: c?.title_pinned ?? null };
  }

  test('automation does not overwrite a pinned title', async () => {
    const id = await insertChat('pinned', true);
    expect(await conversations.updateConversationTitle(id, 'Generated', 'automation')).toBe(false);
    expect(await row(id)).toEqual({ title: 'Original', pinned: true });
  });

  test('automation writes an unpinned title, including a pre-feature NULL row', async () => {
    const unpinned = await insertChat('unpinned', false);
    const legacy = await insertChat('legacy', null);
    expect(await conversations.updateConversationTitle(unpinned, 'Generated', 'automation')).toBe(
      true
    );
    expect(await conversations.updateConversationTitle(legacy, 'Generated', 'automation')).toBe(
      true
    );
    expect(await row(unpinned)).toEqual({ title: 'Generated', pinned: false });
    expect(await row(legacy)).toEqual({ title: 'Generated', pinned: null });
  });

  test('a person pins; an explicit request overrides the pin and keeps it', async () => {
    const id = await insertChat('person', false);
    await conversations.updateConversationTitle(id, 'Named', 'person');
    expect(await row(id)).toEqual({ title: 'Named', pinned: true });
    await conversations.updateConversationTitle(id, 'Requested', 'request');
    expect(await row(id)).toEqual({ title: 'Requested', pinned: true });
  });

  test('an automatic write to a missing chat is still an error', async () => {
    await expect(
      conversations.updateConversationTitle(crypto.randomUUID(), 'x', 'automation')
    ).rejects.toThrow();
  });
});
