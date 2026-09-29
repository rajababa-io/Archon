/**
 * Park running work so a deploy can replace the container, and resume it after.
 *
 * Drain alone refuses new work and waits for old work to finish. On a box running
 * several long agent turns at once that wait outlasts the deploy's budget, and the
 * deploy gives up (#144). Parking ends the wait: after its grace window the deploy
 * asks this server to stop what is still running in a way the next server can pick
 * up, then swaps.
 *
 * PROVENANCE. Everything parked is recorded in `remote_agent_parked_work`, written
 * only here. `replayParked` resumes those rows and nothing else — never a `running`
 * row whose owner it cannot see. Startup orphan cleanup stays off.
 *
 * WHAT PARKS, AND WHAT KEEPS THE DEPLOY WAITING INSTEAD.
 * - A chat on any platform this server holds a `ParkedTurnDispatcher` for: its
 *   running turn is interrupted and its queued messages are taken and persisted.
 *   A chat on a platform with no dispatcher has nowhere to be handed back to, and
 *   a queued message without a replayable payload cannot be delivered later, so
 *   those are reported blocked and waited for.
 * - A workflow run this process executes, that is top-level, has no live child
 *   run, and can be resumed by the server. It is paused on a `park` wait; the
 *   executor stops at the next layer boundary. Anything else is blocked.
 */
import type { ConversationLockManager, ParkableTurn } from '@archon/core';
import { classifyAndFormatError, DeployParkAbort, handleMessage } from '@archon/core';
import type { AttachedFile, Conversation, IPlatformAdapter } from '@archon/core/types';
import * as conversationDb from '@archon/core/db/conversations';
import * as messageDb from '@archon/core/db/messages';
import * as parkedWorkDb from '@archon/core/db/parked-work';
import type { ParkedChatItem, ParkedChatRow, ParkedWorkCounts } from '@archon/core/db/parked-work';
import * as workflowDb from '@archon/core/db/workflows';
import { listActiveWorkflowNodeIds } from '@archon/core/db/workflow-events';
import { isRunOwnedByThisProcess } from '@archon/core/services/run-live-owner';
import { createLogger } from '@archon/paths';
import { isTerminalRunStatus, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { ParkBlockReason } from '../routes/drain-park-reasons';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('deploy-park');
  return cachedLog;
}

/** How long a park waits for interrupted turns to return before answering. */
export const PARK_TURN_STOP_WAIT_MS = 30_000;
/**
 * How long a park lets parked runs' in-flight nodes finish. A node that completes
 * inside it records its completion and is not re-run; one still going is killed
 * by the swap and re-runs on resume.
 */
export const PARK_RUN_FINISH_WINDOW_MS = 90_000;
const PARK_RUN_POLL_MS = 1_000;
/** The engine's run-list page. More running runs than this is not a box a deploy parks. */
const PARK_RUN_SCAN_LIMIT = 100;

/**
 * The one message a resumed chat's agent receives. Addressed to the agent: the
 * turn it was in the middle of was cut off, and the only safe assumption about a
 * cut-off step is that nobody knows whether it finished.
 */
export const DEPLOY_RESUME_PROMPT =
  'Archon restarted for a deploy while your previous turn in this chat was still running, ' +
  'and that turn was stopped part-way. Before doing anything else, check what your last step ' +
  'actually completed — files on disk, command results, git state, anything you had started — ' +
  'and do not assume it finished. Then carry on with the task.';

/** What the chat shows when its parked turn is resumed. */
export const TURN_RESUMED_NOTICE = 'Back after the restart — picking up where this chat left off.';

export function deployResumePrompt(lastUserMessage: string): string {
  if (lastUserMessage.trim() === '') return DEPLOY_RESUME_PROMPT;
  const quoted = lastUserMessage
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
  return `${DEPLOY_RESUME_PROMPT}\n\nFor reference, the last message you received in this chat was:\n\n${quoted}`;
}

export interface ParkBlocked {
  kind: 'chat' | 'run';
  id: string;
  reason: ParkBlockReason;
}

export interface ParkReport {
  drainId: string;
  /** Everything this drain has parked, across repeated park requests. */
  parked: ParkedWorkCounts;
  /** What this request left running; the deploy keeps waiting for these. */
  blocked: ParkBlocked[];
}

/** A parked item handed back to the conversation it came from. */
export type ReplayTurn =
  | { kind: 'resume'; prompt: string; userId: string | null }
  | { kind: 'queued'; turn: ParkableTurn };

/**
 * Delivers a replayed turn to its conversation, through the dispatch the owning
 * platform uses for any turn. Replay owns order and at-most-once; this owns
 * delivery.
 */
export type ParkedTurnDispatcher = (
  conversation: Conversation,
  turn: ReplayTurn
) => Promise<'dispatched' | 'refused_draining'>;

/**
 * The dispatchers this server holds, by `platform_type`. A platform with no entry
 * is not parked, and a row parked for one is left owed until it has one — an
 * adapter that starts after the boot replay picks its rows up on the next tick.
 */
export type ParkedTurnDispatchers = ReadonlyMap<string, ParkedTurnDispatcher>;

export type ParkLockManager = Pick<
  ConversationLockManager,
  'getDrainId' | 'getStats' | 'getParkedConversationIds' | 'takeForPark' | 'interrupt'
>;

export type ReplayLockManager = Pick<ConversationLockManager, 'isDraining' | 'releaseReplayHolds'>;

export interface ParkOptions {
  turnStopWaitMs?: number;
  runFinishWindowMs?: number;
  runPollMs?: number;
}

export class NotDrainingError extends Error {
  constructor() {
    super('The server is not draining, so there is nothing to park for');
    this.name = 'NotDrainingError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function runBlockReason(run: WorkflowRun): ParkBlockReason | undefined {
  if (!isRunOwnedByThisProcess(run.id)) return 'not_owned_by_this_server';
  if (run.parent_run_id !== null) return 'child_run';
  if (run.metadata.isolation === 'container') return 'container_isolation';
  if (!run.working_path) return 'no_working_path';
  return undefined;
}

async function parkRuns(
  drainId: string,
  blocked: ParkBlocked[]
): Promise<{ parkedRunIds: string[] }> {
  const running = await workflowDb.listWorkflowRuns({
    status: 'running',
    limit: PARK_RUN_SCAN_LIMIT,
  });
  const parkedRunIds: string[] = [];
  for (const run of running) {
    let reason = runBlockReason(run);
    if (reason === undefined) {
      const children = await workflowDb.findChildRuns(run.id);
      if (children.some(child => !isTerminalRunStatus(child.status))) reason = 'has_live_child_run';
    }
    if (reason !== undefined) {
      blocked.push({ kind: 'run', id: run.id, reason });
      getLog().info({ runId: run.id, reason }, 'drain.park_blocked');
      continue;
    }
    try {
      const active = (await listActiveWorkflowNodeIds([run.id])).get(run.id) ?? [];
      const now = new Date().toISOString();
      const { parked } = await workflowDb.parkWorkflowRun(run.id, {
        owner: 'node',
        // Only the resume claim key and what a status view shows; the engine
        // re-derives what to run from the events, not from this.
        nodeId: active[0] ?? 'between-nodes',
        kind: 'park',
        waitingSince: now,
        resumeAt: now,
        drainId,
      });
      // A miss means a gate or a terminal write reached the row first: it is no
      // longer running, so there is nothing to park and nothing to wait for.
      if (parked) parkedRunIds.push(run.id);
    } catch (error) {
      getLog().error({ err: error as Error, runId: run.id }, 'drain.park_run_failed');
      blocked.push({ kind: 'run', id: run.id, reason: 'park_failed' });
    }
  }
  return { parkedRunIds };
}

async function parkChats(
  lockManager: ParkLockManager,
  dispatchers: ParkedTurnDispatchers,
  drainId: string,
  blocked: ParkBlocked[]
): Promise<{ stopping: Promise<void>[] }> {
  const stats = lockManager.getStats();
  const alreadyParked = new Set(lockManager.getParkedConversationIds());
  const ids = new Set([
    ...stats.activeConversationIds,
    ...stats.queuedByConversation.map(q => q.conversationId),
  ]);
  const stopping: Promise<void>[] = [];
  for (const platformId of ids) {
    if (alreadyParked.has(platformId)) continue;
    // The lock manager keys on the platform id alone; those are unique across
    // platforms (see `findConversationByPlatformId`).
    const conversation = await conversationDb.findConversationByPlatformId(platformId);
    if (!conversation || !dispatchers.has(conversation.platform_type)) {
      const reason = conversation ? 'platform_cannot_resume' : 'no_conversation_record';
      blocked.push({ kind: 'chat', id: platformId, reason });
      getLog().info(
        { conversationId: platformId, platformType: conversation?.platform_type, reason },
        'drain.park_blocked'
      );
      continue;
    }
    const lastUser = await messageDb.getLastUserMessage(conversation.id);
    const take = lockManager.takeForPark(platformId);
    if (take.status === 'refused') {
      if (take.reason === 'not_draining') throw new NotDrainingError();
      blocked.push({ kind: 'chat', id: platformId, reason: take.reason });
      getLog().info({ conversationId: platformId, reason: take.reason }, 'drain.park_blocked');
      continue;
    }
    const items: ParkedChatItem[] = [
      ...(take.active
        ? [
            {
              kind: 'chat_resume' as const,
              seq: 0,
              content: lastUser?.content ?? '',
              attachedFiles: [] as AttachedFile[],
              userId: lastUser?.user_id ?? conversation.user_id ?? null,
            },
          ]
        : []),
      ...take.queued.map((turn, index) => ({
        kind: 'queued_message' as const,
        seq: index + 1,
        content: turn.text,
        attachedFiles: turn.attachedFiles,
        userId: turn.userId ?? null,
      })),
    ];
    if (items.length === 0) {
      // Its turn ended between the stats read and the take: nothing to park.
      take.restore();
      continue;
    }
    let ids: string[];
    try {
      ids = await parkedWorkDb.insertParkedChat(drainId, conversation.id, items);
    } catch (error) {
      take.restore();
      getLog().error({ err: error as Error, conversationId: platformId }, 'drain.park_chat_failed');
      blocked.push({ kind: 'chat', id: platformId, reason: 'persist_failed' });
      continue;
    }
    if (take.active) {
      const turn = lockManager.interrupt(platformId, new DeployParkAbort());
      if (turn) {
        stopping.push(turn);
      } else if (ids[0] !== undefined) {
        // The turn finished on its own while the rows were being written. There is
        // nothing to resume, and telling the agent it was cut off would be false.
        await parkedWorkDb.discardParkedRow(ids[0]);
      }
    }
    getLog().info(
      { conversationId: platformId, interrupted: take.active, queued: take.queued.length },
      'drain.chat_parked'
    );
  }
  return { stopping };
}

async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Park everything this server can park, and report what it could not.
 *
 * Runs first: the pause write is what stops an executor starting its next layer,
 * so it goes out before the slower chat work. Idempotent — a run already parked
 * is no longer `running` and a chat already parked is skipped — so a deploy may
 * retry a park whose answer it lost.
 *
 * @throws NotDrainingError when drain is off: parked work is replayed whenever the
 *   server is not draining, so parking then would be undone at the next tick.
 */
export async function parkForDeploy(
  lockManager: ParkLockManager,
  dispatchers: ParkedTurnDispatchers,
  options: ParkOptions = {}
): Promise<ParkReport> {
  const drainId = lockManager.getDrainId();
  if (drainId === undefined) throw new NotDrainingError();
  const blocked: ParkBlocked[] = [];

  const { parkedRunIds } = await parkRuns(drainId, blocked);
  const { stopping } = await parkChats(lockManager, dispatchers, drainId, blocked);

  await waitAtMost(Promise.all(stopping), options.turnStopWaitMs ?? PARK_TURN_STOP_WAIT_MS);

  const runDeadline = Date.now() + (options.runFinishWindowMs ?? PARK_RUN_FINISH_WINDOW_MS);
  while (parkedRunIds.some(isRunOwnedByThisProcess) && Date.now() < runDeadline) {
    await sleep(options.runPollMs ?? PARK_RUN_POLL_MS);
  }

  const { parked } = await parkedWorkDb.summarizeDrain(drainId);
  getLog().warn({ drainId, parked, blocked: blocked.length }, 'drain.parked');
  return { drainId, parked, blocked };
}

let replayInProgress = false;

function replayTurn(row: ParkedChatRow): ReplayTurn {
  if (row.kind === 'chat_resume') {
    return { kind: 'resume', prompt: deployResumePrompt(row.content), userId: row.userId };
  }
  return {
    kind: 'queued',
    turn: {
      text: row.content,
      attachedFiles: row.attachedFiles,
      ...(row.userId !== null ? { userId: row.userId } : {}),
    },
  };
}

/**
 * Asks the table, not the pass, what is still owed: a conversation refused this
 * pass, or parked after it listed its rows, keeps holding its new messages.
 */
async function releaseReplayed(lockManager: ReplayLockManager): Promise<void> {
  const owedIds = new Set(
    (await parkedWorkDb.listUnresumedParkedChats()).map(row => row.conversationId)
  );
  const stillOwed = new Set<string>();
  for (const id of owedIds) {
    const conversation = await conversationDb.getConversationById(id);
    if (conversation?.platform_conversation_id) {
      stillOwed.add(conversation.platform_conversation_id);
    }
  }
  lockManager.releaseReplayHolds(stillOwed);
}

/**
 * Hand every parked chat item back to its conversation, in order, at most once.
 *
 * Each row is claimed before it is dispatched, so a crash between the two loses
 * that one row (logged as `deploy_park.replay_claimed`) and never runs it twice.
 * Rows of one conversation are dispatched in `seq` order; the lock manager queues
 * each behind the one before. A dispatch refused because drain came back gives
 * its claim back and stops that conversation, so the rest replay later, still in
 * order. A conversation whose platform has no dispatcher here is not claimed at
 * all: it stays owed until a pass that has one. A pass that reaches the end lets
 * new messages into every conversation with nothing left to replay; until then
 * they queue behind the replay.
 *
 * Parked workflow runs need nothing here: the continuation scanner resumes them
 * once the server stops draining.
 */
export async function replayParked(
  lockManager: ReplayLockManager,
  dispatchers: ParkedTurnDispatchers
): Promise<void> {
  if (replayInProgress || lockManager.isDraining()) return;
  replayInProgress = true;
  try {
    const rows = await parkedWorkDb.listUnresumedParkedChats();
    const stoppedConversations = new Set<string>();
    for (const row of rows) {
      if (stoppedConversations.has(row.conversationId)) continue;
      if (lockManager.isDraining()) return;
      const conversation = await conversationDb.getConversationById(row.conversationId);
      const dispatch = conversation ? dispatchers.get(conversation.platform_type) : undefined;
      if (conversation && !dispatch) {
        getLog().warn(
          { conversationId: row.conversationId, platformType: conversation.platform_type },
          'deploy_park.replay_platform_unavailable'
        );
        stoppedConversations.add(row.conversationId);
        continue;
      }
      if (!(await parkedWorkDb.claimParkedRow(row.id))) continue;
      getLog().info(
        { parkedId: row.id, conversationId: row.conversationId, kind: row.kind, seq: row.seq },
        'deploy_park.replay_claimed'
      );
      if (!conversation || !dispatch) {
        // Nowhere to deliver it, which is final: the row stays claimed.
        getLog().warn(
          { parkedId: row.id, conversationId: row.conversationId },
          'deploy_park.replay_conversation_missing'
        );
        continue;
      }
      let outcome: Awaited<ReturnType<ParkedTurnDispatcher>>;
      try {
        outcome = await dispatch(conversation, replayTurn(row));
      } catch (error) {
        getLog().error(
          { err: error as Error, parkedId: row.id, conversationId: row.conversationId },
          'deploy_park.replay_dispatch_failed'
        );
        outcome = 'refused_draining';
      }
      if (outcome === 'refused_draining') {
        await parkedWorkDb.unclaimParkedRow(row.id);
        stoppedConversations.add(row.conversationId);
      }
    }
    await releaseReplayed(lockManager);
  } finally {
    replayInProgress = false;
  }
}

/**
 * The dispatcher for a platform whose turns are plain `handleMessage` calls under
 * the conversation lock — every adapter but the web one, whose turns also carry
 * SSE and transcript bookkeeping (`dispatchParkedTurn` in routes/api.ts).
 *
 * The conversation's worktree and provider session were bound by the turn that
 * was parked, so the resume needs none of the first-message context (thread
 * history, isolation hints) the adapter's own handler gathers.
 */
export function adapterParkedTurnDispatcher(
  adapter: IPlatformAdapter,
  lockManager: Pick<ConversationLockManager, 'acquireLock'>,
  handle: typeof handleMessage = handleMessage
): ParkedTurnDispatcher {
  return async (conversation, turn) => {
    const platformId = conversation.platform_conversation_id;
    if (turn.kind === 'resume') {
      // Before the dispatch, so the notice sits above the reply it introduces.
      const say = adapter.sendDurableNotice
        ? adapter.sendDurableNotice(platformId, TURN_RESUMED_NOTICE, { category: 'turn_resumed' })
        : adapter.sendMessage(platformId, TURN_RESUMED_NOTICE);
      await say.catch((err: unknown) => {
        getLog().warn({ err, conversationId: platformId }, 'turn_resumed_notice_failed');
      });
    }
    const message = turn.kind === 'resume' ? turn.prompt : turn.turn.text;
    const userId = (turn.kind === 'resume' ? turn.userId : turn.turn.userId) ?? undefined;
    const attachedFiles = turn.kind === 'queued' ? turn.turn.attachedFiles : [];
    const result = await lockManager.acquireLock(
      platformId,
      async ({ signal }) => {
        try {
          await handle(adapter, platformId, message, {
            ...(userId !== undefined ? { userId } : {}),
            ...(attachedFiles.length > 0 ? { attachedFiles } : {}),
            abortSignal: signal,
          });
        } catch (error) {
          getLog().error(
            { err: error as Error, conversationId: platformId },
            'deploy_park.replayed_turn_failed'
          );
          await adapter
            .sendMessage(platformId, classifyAndFormatError(error as Error, adapter))
            .catch((sendError: unknown) => {
              getLog().error(
                { err: sendError, conversationId: platformId },
                'error_message_send_failed'
              );
            });
        }
      },
      undefined,
      'replay'
    );
    return result.status === 'refused-draining' ? 'refused_draining' : 'dispatched';
  };
}
