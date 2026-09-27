/**
 * Integration test: a person's rename that lands while a title is being
 * generated survives, against a REAL bun:sqlite database.
 *
 * The race is between a model call that takes seconds and a PATCH that pins the
 * row inside that window. Only the database can prove the pin check and the
 * write are one step, so the provider is held open by hand and the row is read
 * back from a real table. A mocked pool would only prove which argument was
 * passed.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with other db tests' fakes.
 */
import { describe, test, expect, mock } from 'bun:test';
import type { MessageChunk } from '@archon/providers/types';

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

const { SqliteAdapter, sqliteDialect } = await import('../db/adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('../db/connection', () => ({
  pool: db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

/** What the held-open provider does once released. */
type Outcome = { reply: string } | { error: Error };

/**
 * A provider whose reply waits until the test says so. `called` resolves when
 * the model call has started, which is the window a rename lands in.
 */
function heldProvider(outcome: Outcome): {
  called: Promise<void>;
  release: () => void;
} {
  let markCalled!: () => void;
  const called = new Promise<void>(r => (markCalled = r));
  let release!: () => void;
  const released = new Promise<void>(r => (release = r));
  current = {
    async *sendQuery(): AsyncGenerator<MessageChunk> {
      markCalled();
      await released;
      if ('error' in outcome) throw outcome.error;
      yield { type: 'assistant', content: outcome.reply };
      yield { type: 'result' };
    },
  };
  return { called, release };
}
let current: { sendQuery: () => AsyncGenerator<MessageChunk> } | undefined;

mock.module('./provider-admission', () => ({
  getAgentProvider: () => current,
}));

const conversations = await import('../db/conversations');
const { generateAndSetTitle, reconsiderConversationTitle } = await import('./title-generator');

async function insertChat(id: string, title: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, title)
     VALUES ($1, 'web', $2, $3)`,
    [id, `${id}-platform`, title]
  );
}

async function row(id: string): Promise<{ title: string | null; pinned: boolean }> {
  const c = await conversations.getConversationById(id);
  // SQLite hands the flag back as 0/1.
  return { title: c?.title ?? null, pinned: Boolean(c?.title_pinned) };
}

/** Start generation, rename while the provider is pending, then let it finish. */
async function renameDuringGeneration(id: string, outcome: Outcome): Promise<void> {
  await insertChat(id, 'placeholder');
  const provider = heldProvider(outcome);
  const generating = generateAndSetTitle(id, 'the first message', 'claude', '/tmp');
  await provider.called;
  await conversations.updateConversationTitle(id, 'Named By A Person', 'person');
  provider.release();
  await generating;
}

describe('a pinned rename during first-title generation', () => {
  test('survives a generated title', async () => {
    await renameDuringGeneration('race-success', { reply: 'Generated Title' });
    expect(await row('race-success')).toEqual({ title: 'Named By A Person', pinned: true });
  });

  test('survives the empty-reply fallback', async () => {
    await renameDuringGeneration('race-empty', { reply: '' });
    expect(await row('race-empty')).toEqual({ title: 'Named By A Person', pinned: true });
  });

  test('survives the provider-error fallback', async () => {
    await renameDuringGeneration('race-error', { error: new Error('provider down') });
    expect(await row('race-error')).toEqual({ title: 'Named By A Person', pinned: true });
  });
});

describe('an unpinned chat still gets an automatic title', () => {
  async function generate(id: string, outcome: Outcome): Promise<void> {
    await insertChat(id, 'placeholder');
    const provider = heldProvider(outcome);
    provider.release();
    await generateAndSetTitle(id, 'the first message', 'claude', '/tmp');
  }

  test('the generated title', async () => {
    await generate('free-success', { reply: 'Generated Title' });
    expect(await row('free-success')).toEqual({ title: 'Generated Title', pinned: false });
  });

  test('the truncated-message fallback', async () => {
    await generate('free-error', { error: new Error('provider down') });
    expect(await row('free-error')).toEqual({ title: 'the first message', pinned: false });
  });
});

describe('re-titling uses the same guarded write', () => {
  async function chatWithTenTurns(id: string): Promise<void> {
    await insertChat(id, 'Opening Name');
    for (let i = 0; i < 10; i++) {
      await db.query(
        `INSERT INTO remote_agent_messages (id, conversation_id, role, content)
         VALUES ($1, $2, 'user', $3)`,
        [`${id}-m${String(i)}`, id, `message ${String(i)}`]
      );
    }
  }

  test('a rename during the drift check survives', async () => {
    await chatWithTenTurns('drift-race');
    const provider = heldProvider({ reply: 'Drifted Topic' });
    const reconsidering = reconsiderConversationTitle('drift-race', 'claude', '/tmp');
    await provider.called;
    await conversations.updateConversationTitle('drift-race', 'Named By A Person', 'person');
    provider.release();
    await reconsidering;
    expect(await row('drift-race')).toEqual({ title: 'Named By A Person', pinned: true });
  });

  test('an explicit /retitle still overrides the pin, and keeps it', async () => {
    await chatWithTenTurns('drift-forced');
    await conversations.updateConversationTitle('drift-forced', 'Named By A Person', 'person');
    heldProvider({ reply: 'Drifted Topic' }).release();
    await reconsiderConversationTitle('drift-forced', 'claude', '/tmp', { force: true });
    expect(await row('drift-forced')).toEqual({ title: 'Drifted Topic', pinned: true });
  });
});

describe('updateConversationTitle', () => {
  test('an automatic write to a missing chat is still an error, not a silent skip', async () => {
    await expect(
      conversations.updateConversationTitle('no-such-chat', 'x', 'automation')
    ).rejects.toThrow();
  });
});
