/**
 * CI watches against a REAL bun:sqlite database.
 *
 * What these prove is about rows: that a watch fires at most once when two
 * callers race for it, that a refused delivery puts it back, that closing a
 * chat takes its watches with it. A mocked pool would pass every one of those
 * without the compare-and-set or the partial unique index existing.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ../db/connection with a real adapter.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

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

const { openCiWatch, listCiWaitingPlatformConversationIds, listOpenCiWatches } =
  await import('../db/ci-watches');
const { setConversationCompleted } = await import('../db/conversations');
const { settleCiWatchesForHead, reconcileCiWatches, CI_WATCH_MAX_AGE_MS } =
  await import('./ci-watch');
type Deps = import('./ci-watch').CiWatchDeps;
type HeadChecks = import('./ci-watch').HeadChecks;
type CiWatchDelivery = import('./ci-watch').CiWatchDelivery;

const SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);

const PASSED: HeadChecks = {
  kind: 'complete',
  checks: [
    { name: 'lint', conclusion: 'success' },
    { name: 'test', conclusion: 'success' },
  ],
};

function harness(
  checks: HeadChecks,
  delivery: CiWatchDelivery = 'delivered'
): { deps: Deps; reads: string[]; sent: { conversationId: string; message: string }[] } {
  const reads: string[] = [];
  const sent: { conversationId: string; message: string }[] = [];
  return {
    reads,
    sent,
    deps: {
      readHeadChecks: async (repo, headSha): Promise<HeadChecks> => {
        reads.push(`${repo}@${headSha}`);
        return checks;
      },
      deliver: async (watch, message): Promise<CiWatchDelivery> => {
        if (delivery === 'delivered') sent.push({ conversationId: watch.conversationId, message });
        return delivery;
      },
    },
  };
}

let chatCounter = 0;
async function newChat(): Promise<string> {
  chatCounter += 1;
  const id = `chat-${String(chatCounter)}`;
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ($1, 'web', $2)`,
    [id, `web-${id}`]
  );
  return id;
}

beforeEach(async () => {
  await db.query('DELETE FROM remote_agent_ci_watches');
});

describe('settleCiWatchesForHead — the webhook path', () => {
  test('all checks finished: exactly one message, to the chat that asked', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'Owner/Repo', headSha: SHA, pullRequest: 7 });
    const { deps, sent } = harness(PASSED);

    // The delivery names the repository in GitHub's own casing.
    expect(await settleCiWatchesForHead('Owner/Repo', SHA, deps)).toBe(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.conversationId).toBe(chat);
    expect(sent[0]?.message).toContain('Automated message');
    expect(sent[0]?.message).toContain('owner/repo@bbbbbbb (PR #7)');
    expect(sent[0]?.message).toContain('all 2 checks passed');
  });

  test('checks still running: nothing is sent and the watch stays open', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/r', headSha: SHA, pullRequest: null });
    const { deps, sent } = harness({ kind: 'pending' });

    expect(await settleCiWatchesForHead('o/r', SHA, deps)).toBe(0);
    expect(sent).toEqual([]);
    expect(await listOpenCiWatches()).toHaveLength(1);
  });

  test('a commit nobody watches is not even looked up', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/r', headSha: SHA, pullRequest: null });
    const { deps, sent, reads } = harness(PASSED);

    expect(await settleCiWatchesForHead('o/r', OTHER_SHA, deps)).toBe(0);
    expect(reads).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('a second delivery for the same commit sends nothing — the watch has fired', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/r', headSha: SHA, pullRequest: null });
    const { deps, sent } = harness(PASSED);

    await settleCiWatchesForHead('o/r', SHA, deps);
    await settleCiWatchesForHead('o/r', SHA, deps);
    await reconcileCiWatches(deps);

    expect(sent).toHaveLength(1);
  });

  test('racing callers fire a watch once', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/r', headSha: SHA, pullRequest: null });
    const { deps, sent } = harness(PASSED);

    await Promise.all([
      settleCiWatchesForHead('o/r', SHA, deps),
      settleCiWatchesForHead('o/r', SHA, deps),
      reconcileCiWatches(deps),
    ]);

    expect(sent).toHaveLength(1);
  });

  test('failing checks are named', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/r', headSha: SHA, pullRequest: null });
    const { deps, sent } = harness({
      kind: 'complete',
      checks: [
        { name: 'lint', conclusion: 'success' },
        { name: 'test', conclusion: 'failure' },
        { name: 'docs', conclusion: 'skipped' },
      ],
    });

    await settleCiWatchesForHead('o/r', SHA, deps);

    expect(sent[0]?.message).toContain('1 of 3 checks did not pass — test (failure)');
  });

  test('a refused delivery hands the watch back, and the next pass sends it', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/r', headSha: SHA, pullRequest: null });

    const refused = harness(PASSED, 'refused');
    expect(await settleCiWatchesForHead('o/r', SHA, refused.deps)).toBe(0);
    expect(await listOpenCiWatches()).toHaveLength(1);

    const accepted = harness(PASSED);
    expect(await reconcileCiWatches(accepted.deps)).toBe(1);
    expect(accepted.sent).toHaveLength(1);
  });

  test('a delivery that throws is not retried — at most once outranks at all', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/r', headSha: SHA, pullRequest: null });
    const { deps } = harness(PASSED);
    const throwing: Deps = { ...deps, deliver: () => Promise.reject(new Error('no chat')) };

    expect(await settleCiWatchesForHead('o/r', SHA, throwing)).toBe(0);
    expect(await listOpenCiWatches()).toEqual([]);
  });
});

describe('reconcileCiWatches — the safety net', () => {
  test('fires a watch whose checks finished while no webhook arrived', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/r', headSha: SHA, pullRequest: null });
    const { deps, sent, reads } = harness(PASSED);

    expect(await reconcileCiWatches(deps)).toBe(1);
    expect(reads).toEqual([`o/r@${SHA}`]);
    expect(sent[0]?.conversationId).toBe(chat);
  });

  test('asks the forge once per commit, however many chats watch it', async () => {
    for (let i = 0; i < 3; i++) {
      await openCiWatch({
        conversationId: await newChat(),
        repo: 'o/r',
        headSha: SHA,
        pullRequest: null,
      });
    }
    const { deps, sent, reads } = harness(PASSED);

    expect(await reconcileCiWatches(deps)).toBe(3);
    expect(reads).toHaveLength(1);
    expect(sent).toHaveLength(3);
  });

  test('a watch that never finishes reports so after a day, instead of waiting forever', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/r', headSha: SHA, pullRequest: null });
    const { deps, sent } = harness({ kind: 'pending' });

    expect(await reconcileCiWatches(deps)).toBe(0);
    const later = new Date(Date.now() + CI_WATCH_MAX_AGE_MS + 60_000);
    expect(await reconcileCiWatches(deps, later)).toBe(1);
    expect(sent[0]?.message).toContain('CI never finished');
  });

  test("one commit's forge error does not stop the others", async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/broken', headSha: SHA, pullRequest: null });
    await openCiWatch({ conversationId: chat, repo: 'o/fine', headSha: SHA, pullRequest: null });
    const { deps, sent } = harness(PASSED);
    const flaky: Deps = {
      ...deps,
      readHeadChecks: (repo, headSha) =>
        repo === 'o/broken' ? Promise.reject(new Error('502')) : deps.readHeadChecks(repo, headSha),
    };

    expect(await reconcileCiWatches(flaky)).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe('the watch rows', () => {
  test('watching the same commit twice is one watch', async () => {
    const chat = await newChat();
    const first = await openCiWatch({
      conversationId: chat,
      repo: 'O/R',
      headSha: SHA,
      pullRequest: null,
    });
    const second = await openCiWatch({
      conversationId: chat,
      repo: 'o/r',
      headSha: SHA,
      pullRequest: 3,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.watch.id).toBe(first.watch.id);
    expect(await listOpenCiWatches()).toHaveLength(1);
  });

  test('a fired watch does not block watching the same commit again', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/r', headSha: SHA, pullRequest: null });
    await settleCiWatchesForHead('o/r', SHA, harness(PASSED).deps);

    const again = await openCiWatch({
      conversationId: chat,
      repo: 'o/r',
      headSha: SHA,
      pullRequest: null,
    });
    expect(again.created).toBe(true);
  });

  test('the waiting set is the platform ids of chats with an open watch', async () => {
    const waiting = await newChat();
    const fired = await newChat();
    await openCiWatch({ conversationId: waiting, repo: 'o/r', headSha: SHA, pullRequest: null });
    await openCiWatch({
      conversationId: fired,
      repo: 'o/r',
      headSha: OTHER_SHA,
      pullRequest: null,
    });
    await settleCiWatchesForHead('o/r', OTHER_SHA, harness(PASSED).deps);

    expect(await listCiWaitingPlatformConversationIds()).toEqual([`web-${waiting}`]);
  });

  test('closing a chat cancels its watches, so CI finishing later sends nothing', async () => {
    const chat = await newChat();
    await openCiWatch({ conversationId: chat, repo: 'o/r', headSha: SHA, pullRequest: null });

    await setConversationCompleted(chat, true);

    const { deps, sent } = harness(PASSED);
    expect(await settleCiWatchesForHead('o/r', SHA, deps)).toBe(0);
    expect(sent).toEqual([]);
    expect(await listCiWaitingPlatformConversationIds()).toEqual([]);
  });
});
