/**
 * Integration test: the project artifact index's two queries (#351) against a
 * REAL bun:sqlite database — the JSON filter on message metadata and the
 * parent-chat join only prove themselves on a real adapter.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter.
 */
import { describe, test, expect, mock } from 'bun:test';

const realPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realPaths,
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

const { listArtifactRuns, listHandoffSeeds, getHandoffSeed } = await import('./project-artifacts');
const { readLineage, lineageMetadata } = await import('../orchestrator/handoff');

for (const id of ['cb-1', 'cb-2']) {
  await db.query(
    `INSERT INTO remote_agent_codebases (id, name, default_cwd, kind) VALUES ($1, $1, '/tmp/x', 'repo')`,
    [id]
  );
}
for (const [id, codebase, title, done, ready, deleted] of [
  ['chat-a', 'cb-1', '#343 Ready to close', null, '2026-09-30 10:00:00', null],
  ['chat-b', 'cb-1', 'Context Bar 7', '2026-09-30 10:00:00', null, null],
  ['chat-gone', 'cb-1', 'Deleted', null, null, '2026-09-30 10:00:00'],
  ['chat-other', 'cb-2', 'Elsewhere', null, null, null],
  ['worker', 'cb-1', null, null, null, null],
] as const) {
  await db.query(
    `INSERT INTO remote_agent_conversations
       (id, platform_type, platform_conversation_id, codebase_id, title, completed_at, ready_at, deleted_at)
     VALUES ($1, 'web', $2, $3, $4, $5, $6, $7)`,
    [id, `web-${id}`, codebase, title, done, ready, deleted]
  );
}

async function seedRun(
  id: string,
  codebase: string,
  parent: string | null,
  startedAt: string
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, parent_conversation_id, codebase_id, user_message,
        status, metadata, started_at, last_activity_at)
     VALUES ($1, 'archon-deliver', 'worker', $2, $3, 'go', 'completed', '{}', $4, $4)`,
    [id, parent, codebase, startedAt]
  );
}
await seedRun('run-old', 'cb-1', 'chat-a', '2026-09-29 10:00:00');
await seedRun('run-new', 'cb-1', 'chat-b', '2026-09-30 10:00:00');
await seedRun('run-cli', 'cb-1', null, '2026-09-30 09:00:00');
await seedRun('run-gone', 'cb-1', 'chat-gone', '2026-09-28 09:00:00');
await seedRun('run-other', 'cb-2', 'chat-other', '2026-09-30 11:00:00');

async function seedMessage(
  id: string,
  conversation: string,
  role: string,
  metadata: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_messages (id, conversation_id, role, content, metadata, created_at)
     VALUES ($1, $2, $3, 'seed', $4, '2026-09-30 12:00:00')`,
    [id, conversation, role, JSON.stringify(metadata)]
  );
}
const lineage = lineageMetadata({ from: 'chat-a', document: '/home/u/handoffs/2026-09-30_bar.md' });
await seedMessage('m-handoff', 'chat-b', 'user', lineage);
await seedMessage('m-plain', 'chat-b', 'user', { toolCalls: [] });
await seedMessage('m-assistant', 'chat-a', 'assistant', lineage);
await seedMessage('m-deleted', 'chat-gone', 'user', lineage);
await seedMessage('m-other', 'chat-other', 'user', lineage);

describe('listArtifactRuns', () => {
  test("the project's runs newest first, each with the chat that started it", async () => {
    const rows = await listArtifactRuns('cb-1', 10);
    expect(rows.map(r => r.id)).toEqual(['run-new', 'run-cli', 'run-old', 'run-gone']);
    expect(rows[0]?.chat).toEqual({
      id: 'web-chat-b',
      title: 'Context Bar 7',
      done: true,
      ready: false,
    });
    expect(rows[2]?.chat).toEqual({
      id: 'web-chat-a',
      title: '#343 Ready to close',
      done: false,
      ready: true,
    });
    // No originating chat, or a deleted one, reads as none.
    expect(rows[1]?.chat).toBeNull();
    expect(rows[3]?.chat).toBeNull();
    expect(rows[0]?.started_at).toBeInstanceOf(Date);
  });

  test('honours the limit', async () => {
    expect((await listArtifactRuns('cb-1', 2)).map(r => r.id)).toEqual(['run-new', 'run-cli']);
  });
});

describe('handoff seeds', () => {
  test("only user rows carrying lineage, in this project's live chats", async () => {
    const rows = await listHandoffSeeds('cb-1', 10);
    expect(rows.map(r => r.id)).toEqual(['m-handoff']);
    expect(readLineage(rows[0]?.metadata ?? '')?.document).toBe(
      '/home/u/handoffs/2026-09-30_bar.md'
    );
    expect(rows[0]?.chat.id).toBe('web-chat-b');
  });

  test('one seed is found only through its own project', async () => {
    expect((await getHandoffSeed('cb-1', 'm-handoff'))?.id).toBe('m-handoff');
    expect(await getHandoffSeed('cb-2', 'm-handoff')).toBeNull();
    expect(await getHandoffSeed('cb-1', 'm-plain')).toBeNull();
    expect(await getHandoffSeed('cb-1', 'm-deleted')).toBeNull();
  });
});
