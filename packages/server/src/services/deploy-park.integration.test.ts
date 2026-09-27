/**
 * End to end: park what a busy server is running, "restart", and resume it.
 *
 * Real `ConversationLockManager`, real `parkForDeploy` / `replayParked`, a real
 * SQLite database, and a scripted chat turn that runs until it is interrupted —
 * the long agent turn a deploy cannot wait out. The only fake is the dispatcher a
 * resumed turn is handed to, because what is under test is WHAT gets replayed and
 * in which order, not the orchestrator it is replayed into.
 *
 * Runs in its own `bun test` invocation (see package.json): it replaces the core
 * database connection with an in-memory adapter.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';

const { SqliteAdapter, sqliteDialect } = await import('@archon/core/db/adapters/sqlite');
const db = new SqliteAdapter(':memory:');
const realConnection = await import('@archon/core/db/connection');
mock.module('@archon/core/db/connection', () => ({
  ...realConnection,
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { ConversationLockManager, DeployParkAbort } = await import('@archon/core');
const conversationDb = await import('@archon/core/db/conversations');
const messageDb = await import('@archon/core/db/messages');
const parkedWorkDb = await import('@archon/core/db/parked-work');
const workflowDb = await import('@archon/core/db/workflows');
const { startRunLiveOwner } = await import('@archon/core/services/run-live-owner');
const { parkForDeploy, replayParked, DEPLOY_RESUME_PROMPT } = await import('./deploy-park');
type ReplayTurn = import('./deploy-park').ReplayTurn;
type LockManager = InstanceType<typeof ConversationLockManager>;

/** A turn that runs until the manager aborts it, and remembers why it ended. */
function scriptedLongTurn(manager: LockManager, platformId: string): { ended: Promise<unknown> } {
  let resolveEnded!: (reason: unknown) => void;
  const ended = new Promise<unknown>(resolve => {
    resolveEnded = resolve;
  });
  void manager.acquireLock(platformId, async ({ signal }) => {
    await new Promise<void>(resolve => {
      signal.addEventListener('abort', () => resolve());
    });
    resolveEnded(signal.reason);
  });
  return { ended };
}

async function webChat(platformId: string): Promise<string> {
  return (await conversationDb.getOrCreateConversation('web', platformId)).id;
}

async function runningRun(id: string, conversationId: string): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, user_message, status, working_path, started_at, last_activity_at, metadata)
     VALUES ($1, 'deliver', $2, 'go', 'running', '/tmp/work', datetime('now'), datetime('now'), '{}')`,
    [id, conversationId]
  );
}

interface Dispatched {
  conversationId: string;
  turn: ReplayTurn;
}

function recordingDispatcher(
  answer: (call: Dispatched) => 'dispatched' | 'refused_draining' = () => 'dispatched'
): { calls: Dispatched[]; dispatch: Parameters<typeof replayParked>[1] } {
  const calls: Dispatched[] = [];
  return {
    calls,
    dispatch: async (conversationId, turn) => {
      const call = { conversationId, turn };
      calls.push(call);
      return answer(call);
    },
  };
}

const describeText = (call: Dispatched): string =>
  call.turn.kind === 'resume' ? 'resume' : `queued:${call.turn.turn.text}`;

const owners: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(owners.map(owner => owner.close()));
});

describe('a deploy parks a busy server and the next server resumes it', () => {
  test('three chats mid-turn, a queued message and a running run', async () => {
    const oldServer = new ConversationLockManager(10);

    const chatA = await webChat('chat-a');
    const chatB = await webChat('chat-b');
    const chatC = await webChat('chat-c');
    await conversationDb.getOrCreateConversation('slack', 'slack-thread');
    await messageDb.addMessage(chatA, 'user', 'refactor the parser\nand run the tests');

    const turnA = scriptedLongTurn(oldServer, 'chat-a');
    const turnB = scriptedLongTurn(oldServer, 'chat-b');
    const turnC = scriptedLongTurn(oldServer, 'chat-c');
    scriptedLongTurn(oldServer, 'slack-thread');
    const queuedDelivered = mock(async () => {});
    await oldServer.acquireLock('chat-a', queuedDelivered, {
      text: 'also update the docs',
      parkable: { text: 'also update the docs', attachedFiles: [], userId: 'user-1' },
    });

    await runningRun('run-owned', chatA);
    await runningRun('run-elsewhere', chatB);
    owners.push(await startRunLiveOwner('run-owned'));

    oldServer.beginDrain(600);
    const report = await parkForDeploy(oldServer, { runFinishWindowMs: 0 });

    // What was parked, and what keeps the deploy waiting.
    expect(report.parked).toEqual({ chats: 3, queuedMessages: 1, runs: 1 });
    expect(report.blocked).toEqual(
      expect.arrayContaining([
        { kind: 'chat', id: 'slack-thread', reason: 'non_web_platform' },
        { kind: 'run', id: 'run-elsewhere', reason: 'not_owned_by_this_server' },
      ])
    );
    expect(report.blocked).toHaveLength(2);

    // Each chat turn was stopped as a park, so it can say so.
    for (const turn of [turnA, turnB, turnC]) {
      expect(await turn.ended).toBeInstanceOf(DeployParkAbort);
    }
    expect(queuedDelivered).not.toHaveBeenCalled();
    expect(oldServer.getStats().queuedTotal).toBe(0);
    expect(oldServer.isActive('slack-thread')).toBe(true);

    // The owned run is paused on a park wait; the ambiguous one is untouched.
    const owned = await workflowDb.getWorkflowRun('run-owned');
    expect(owned?.status).toBe('paused');
    expect(owned?.metadata.wait).toMatchObject({ kind: 'park', drainId: report.drainId });
    expect((await workflowDb.getWorkflowRun('run-elsewhere'))?.status).toBe('running');

    // Re-asking is harmless: nothing is parked twice.
    const again = await parkForDeploy(oldServer, { runFinishWindowMs: 0 });
    expect(again.parked).toEqual(report.parked);

    // THE SWAP. A new process: fresh lock manager, same database.
    const newServer = new ConversationLockManager(10);
    const first = recordingDispatcher();
    await replayParked(newServer, first.dispatch);

    const byChat = (id: string): string[] =>
      first.calls.filter(call => call.conversationId === id).map(describeText);
    expect(byChat(chatA)).toEqual(['resume', 'queued:also update the docs']);
    expect(byChat(chatB)).toEqual(['resume']);
    expect(byChat(chatC)).toEqual(['resume']);

    const resumeA = first.calls.find(call => call.conversationId === chatA)?.turn;
    expect(resumeA?.kind).toBe('resume');
    if (resumeA?.kind === 'resume') {
      expect(resumeA.prompt.startsWith(DEPLOY_RESUME_PROMPT)).toBe(true);
      expect(resumeA.prompt).toContain('> refactor the parser\n> and run the tests');
    }
    const queuedA = first.calls.find(call => call.turn.kind === 'queued')?.turn;
    expect(queuedA).toEqual({
      kind: 'queued',
      turn: { text: 'also update the docs', attachedFiles: [], userId: 'user-1' },
    });

    // A second boot replays nothing: every marker was cleared exactly once.
    const second = recordingDispatcher();
    await replayParked(new ConversationLockManager(10), second.dispatch);
    expect(second.calls).toEqual([]);

    // The parked run is due for the continuation scanner.
    const due = await workflowDb.listDueWorkflowContinuations(new Date(Date.now() + 1000), 25);
    expect(due.map(run => run.id)).toContain('run-owned');
    const summary = await parkedWorkDb.summarizeDrain(report.drainId);
    expect(summary.resumed).toEqual({ chats: 3, queuedMessages: 1, runs: 0 });
  });

  test('a crash after a claim never replays that row twice, and the rest still come in order', async () => {
    const chat = await webChat('chat-crash');
    const drainId = '6f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
    const ids = await parkedWorkDb.insertParkedChat(drainId, chat, [
      { kind: 'chat_resume', seq: 0, content: '', attachedFiles: [], userId: null },
      { kind: 'queued_message', seq: 1, content: 'one', attachedFiles: [], userId: null },
      { kind: 'queued_message', seq: 2, content: 'two', attachedFiles: [], userId: null },
    ]);
    // The boot that crashed had claimed the first row and died before dispatching it.
    expect(await parkedWorkDb.claimParkedRow(ids[0] ?? '')).toBe(true);

    const replay = recordingDispatcher();
    await replayParked(new ConversationLockManager(10), replay.dispatch);

    expect(replay.calls.map(describeText)).toEqual(['queued:one', 'queued:two']);
  });

  test('a drain that comes back mid-replay hands its claim back and keeps the order', async () => {
    const chat = await webChat('chat-refused');
    const drainId = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
    await parkedWorkDb.insertParkedChat(drainId, chat, [
      { kind: 'queued_message', seq: 1, content: 'one', attachedFiles: [], userId: null },
      { kind: 'queued_message', seq: 2, content: 'two', attachedFiles: [], userId: null },
    ]);

    const refused = recordingDispatcher(() => 'refused_draining');
    await replayParked(new ConversationLockManager(10), refused.dispatch);
    // Refused once, then that conversation stops: 'two' is never tried ahead of 'one'.
    expect(refused.calls.map(describeText)).toEqual(['queued:one']);

    const later = recordingDispatcher();
    await replayParked(new ConversationLockManager(10), later.dispatch);
    expect(later.calls.map(describeText)).toEqual(['queued:one', 'queued:two']);
  });

  test('nothing is replayed while the server is draining', async () => {
    const chat = await webChat('chat-draining');
    await parkedWorkDb.insertParkedChat('8b7c6d5e-4f3a-4b2c-9d1e-0f1a2b3c4d5e', chat, [
      { kind: 'queued_message', seq: 1, content: 'wait', attachedFiles: [], userId: null },
    ]);

    const draining = recordingDispatcher();
    const drainingServer = new ConversationLockManager(10);
    drainingServer.beginDrain(600);
    await replayParked(drainingServer, draining.dispatch);
    expect(draining.calls).toEqual([]);

    const after = recordingDispatcher();
    await replayParked(new ConversationLockManager(10), after.dispatch);
    expect(after.calls.map(describeText)).toEqual(['queued:wait']);
  });

  test('a message sent after un-parking runs after the parked backlog; other chats start at once', async () => {
    const server = new ConversationLockManager(10);
    const chat = await webChat('chat-unparked');
    const log: string[] = [];
    const turn = (label: string) => async (): Promise<void> => {
      log.push(label);
    };
    const parked = scriptedLongTurn(server, 'chat-unparked');
    await server.acquireLock('chat-unparked', turn('queued-before-drain'), {
      text: 'queued',
      parkable: { text: 'queued', attachedFiles: [] },
    });

    server.beginDrain(600);
    await parkForDeploy(server, { runFinishWindowMs: 0 });
    await parked.ended;

    // The deploy failed before its swap. Between the cancel and the replay:
    server.cancelDrain();
    const early = await server.acquireLock('chat-unparked', turn('sent-after-cancel'));
    expect(early.status).toBe('queued-conversation');
    const unrelated = await server.acquireLock('chat-unrelated', turn('unrelated'));
    expect(unrelated.status).toBe('started');

    // Delivery the way the web dispatcher does it: through the same lock, as a replay.
    const dispatch: Parameters<typeof replayParked>[1] = async (conversationId, replayed) => {
      expect(conversationId).toBe(chat);
      const label = replayed.kind === 'resume' ? 'resume' : `replayed:${replayed.turn.text}`;
      await server.acquireLock('chat-unparked', turn(label), undefined, 'replay');
      return 'dispatched';
    };
    await replayParked(server, dispatch);
    for (let tick = 0; tick < 100 && log.length < 4; tick++) await Promise.resolve();

    expect(log.filter(label => label !== 'unrelated')).toEqual([
      'resume',
      'replayed:queued',
      'sent-after-cancel',
    ]);
  });

  test('a pass that could not replay a chat keeps it held while the chats it finished are let go', async () => {
    const server = new ConversationLockManager(10);
    const owed = await webChat('chat-owed');
    await webChat('chat-done');
    const ownedTurns = [
      scriptedLongTurn(server, 'chat-owed'),
      scriptedLongTurn(server, 'chat-done'),
    ];

    server.beginDrain(600);
    await parkForDeploy(server, { runFinishWindowMs: 0 });
    await Promise.all(ownedTurns.map(turn => turn.ended));
    server.cancelDrain();

    const dispatch: Parameters<typeof replayParked>[1] = async conversationId => {
      if (conversationId === owed) return 'refused_draining';
      await server.acquireLock('chat-done', async () => {}, undefined, 'replay');
      return 'dispatched';
    };
    await replayParked(server, dispatch);
    for (let tick = 0; tick < 100 && server.isActive('chat-done'); tick++) await Promise.resolve();

    const done = await server.acquireLock('chat-done', async () => {});
    expect(done.status).toBe('started');
    const stillOwed = await server.acquireLock('chat-owed', async () => {});
    expect(stillOwed.status).toBe('queued-conversation');
  });

  test('parking outside a drain is refused, so nothing is parked only to be replayed at once', async () => {
    await expect(parkForDeploy(new ConversationLockManager(10))).rejects.toThrow('not draining');
  });
});
