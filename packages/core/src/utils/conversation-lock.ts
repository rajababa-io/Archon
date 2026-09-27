/**
 * Conversation Lock Manager
 *
 * Manages non-blocking concurrent conversation handling with:
 * - Global concurrency limit (max N conversations simultaneously)
 * - Per-conversation ordering (messages process sequentially per conversation)
 * - Explicit queueing with observability
 * - Drain: stop admitting new turns so a deploy can replace the process
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '@archon/paths';

import type { AttachedFile, IPlatformAdapter } from '../types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('conversation-lock');
  return cachedLog;
}

/**
 * What a turn's handler is handed when it starts.
 *
 * `signal` is the one way to end a running turn early: `interrupt()` aborts it,
 * and the handler passes it to its provider as the request's abort signal. The
 * manager owns it rather than the caller because the manager is already the
 * owner of "which turn is running for this conversation" — a second registry
 * would be a second answer to the same question.
 */
export interface TurnContext {
  signal: AbortSignal;
}

export type TurnHandler = (turn: TurnContext) => Promise<void>;

/**
 * A queued message as a sender may see it, so it can be shown while it waits
 * and taken back before it is delivered.
 *
 * Only callers that can show a queue describe their messages; the rest queue
 * anonymously and `listQueued` does not report them.
 */
export interface QueuedMessageInfo {
  id: string;
  text: string;
  files: { name: string; mimeType: string; size: number }[];
  queuedAt: string;
}

/** The describable part of a message, supplied by the caller at acquisition. */
export interface QueueDescription {
  text: string;
  files?: QueuedMessageInfo['files'];
  /**
   * Runs when the message is withdrawn instead of delivered — whatever the
   * handler would have cleaned up after itself (staged uploads) it now never
   * will. Never runs for a delivered message.
   */
  onWithdraw?: () => Promise<void>;
  /**
   * Everything needed to deliver this message from a different process. Only a
   * message that carries it can be parked by a deploy; one that does not keeps
   * the deploy waiting for it instead.
   */
  parkable?: ParkableTurn;
}

/** A queued message as a deploy persists it, to be delivered by the next server. */
export interface ParkableTurn {
  text: string;
  userId?: string;
  attachedFiles: AttachedFile[];
}

/**
 * What `takeForPark` did. `taken` carries `restore`, which puts the messages back
 * at the head of the queue in their original order — for when they could not be
 * persisted, so a failed park leaves the conversation exactly as it was.
 */
export type ParkTakeResult =
  | {
      status: 'taken';
      /** A turn was running and still needs `interrupt` once the take is persisted. */
      active: boolean;
      /** The queued messages, oldest first. */
      queued: ParkableTurn[];
      restore: () => void;
    }
  | { status: 'refused'; reason: 'not_draining' | 'unparkable_queued_turn' };

/**
 * The abort reason a deploy's park gives `interrupt`, so the turn can tell the
 * chat it was paused for a restart rather than stopped by the user.
 */
export class DeployParkAbort extends Error {
  constructor() {
    super('Paused for a deploy');
    this.name = 'DeployParkAbort';
  }
}

/**
 * Represents a queued message waiting for processing
 */
interface QueuedMessage {
  id: string;
  handler: TurnHandler;
  timestamp: number;
  description?: QueueDescription;
}

/** A turn executing now, and the switch that ends it early. */
interface ActiveTurn {
  promise: Promise<void>;
  controller: AbortController;
}

/**
 * The single answer to "take this queued message back": exactly one of these,
 * decided synchronously against the queue, so a withdrawal racing delivery has
 * one winner. `not-queued` covers the message having already been delivered —
 * the manager keeps no record of delivered messages, so it cannot tell that
 * apart from an id it never issued, and does not pretend to.
 */
export type WithdrawResult =
  | { status: 'withdrawn'; message: QueuedMessageInfo }
  | { status: 'not-queued' };

/**
 * Result of acquiring a lock, indicating whether the message was started, queued,
 * or refused because the server is draining
 */
export interface LockAcquisitionResult {
  status: 'started' | 'queued-conversation' | 'queued-capacity' | 'refused-draining';
  /** Set when queued: the id `withdraw` takes. */
  queuedId?: string;
}

/**
 * What a draining manager is holding open, for an operator watching a deploy wait.
 * `refusedCount` is cumulative across the whole drain, including re-requests.
 */
export interface DrainStatus {
  requestedAt: string;
  expiresAt: string;
  refusedCount: number;
}

/**
 * The one sentence every caller shows someone whose message drain refused. Nothing
 * retries a refused message, so it has to say the work was not accepted and what to
 * do about it — a vaguer notice would read as "received" and lose the message.
 */
export const DRAIN_REFUSAL_NOTICE =
  'Archon is restarting and is not accepting new work right now. Nothing was started — ' +
  'please try again in a moment.';

/**
 * Tells a sender their message was refused because the server is draining for a
 * restart, when — and only when — that is what happened. Nothing queued the message
 * and nothing will retry it, so silence here would be exactly the drop drain exists
 * to avoid; a failure to deliver the notice is logged rather than thrown, because the
 * caller has already finished with the message and has nothing left to undo.
 *
 * Every platform that acquires a lock shares this so the decision, the wording and
 * the log line cannot drift apart per adapter.
 */
export async function notifyDrainRefusal(
  platform: string,
  adapter: Pick<IPlatformAdapter, 'sendMessage'>,
  conversationId: string,
  result: LockAcquisitionResult
): Promise<void> {
  if (result.status !== 'refused-draining') return;
  try {
    await adapter.sendMessage(conversationId, DRAIN_REFUSAL_NOTICE);
  } catch (sendError) {
    getLog().error({ err: sendError, platform, conversationId }, 'drain_notice_send_failed');
  }
}

/** Internal drain bookkeeping; `expiresAtMs` is compared against an injectable clock. */
interface DrainState {
  requestedAt: string;
  expiresAtMs: number;
  refusedCount: number;
  /** Names what this drain parks, so everything one deploy parked shares one id. */
  drainId: string;
  /** Conversations whose work was parked: not counted as held while their turn winds down. */
  parkedConversations: Set<string>;
}

function toDrainStatus(state: DrainState): DrainStatus {
  return {
    requestedAt: state.requestedAt,
    expiresAt: new Date(state.expiresAtMs).toISOString(),
    refusedCount: state.refusedCount,
  };
}

function toQueuedInfo(message: QueuedMessage, description: QueueDescription): QueuedMessageInfo {
  return {
    id: message.id,
    text: description.text,
    files: description.files ?? [],
    queuedAt: new Date(message.timestamp).toISOString(),
  };
}

/**
 * Manages conversation locks for concurrent message processing
 */
export class ConversationLockManager {
  private activeConversations: Map<string, ActiveTurn>;
  private messageQueues: Map<string, QueuedMessage[]>;
  private maxConcurrent: number;
  private drainState: DrainState | undefined;

  /**
   * Creates a new ConversationLockManager
   * @param maxConcurrent - Maximum number of concurrent conversations (default: 10)
   */
  constructor(maxConcurrent = 10) {
    this.activeConversations = new Map<string, ActiveTurn>();
    this.messageQueues = new Map<string, QueuedMessage[]>();
    this.maxConcurrent = maxConcurrent;
    getLog().info({ maxConcurrent }, 'initialized');
  }

  /**
   * Acquire lock for conversation and execute handler
   * Non-blocking: returns immediately, handler executes async
   *
   * This is the server's external admission point, so it is where drain refuses.
   * @param conversationId - Unique conversation identifier
   * @param handler - Async function to execute
   * @param description - Makes the message visible and withdrawable while queued
   */
  async acquireLock(
    conversationId: string,
    handler: TurnHandler,
    description?: QueueDescription
  ): Promise<LockAcquisitionResult> {
    const draining = this.currentDrain();
    if (draining) {
      draining.refusedCount += 1;
      getLog().info(
        { conversationId, refusedCount: draining.refusedCount },
        'refused_while_draining'
      );
      return { status: 'refused-draining' };
    }
    return this.admit(conversationId, {
      id: randomUUID(),
      handler,
      timestamp: Date.now(),
      description,
    });
  }

  /**
   * Admit a message: run it now, or queue it behind the conversation or the global
   * capacity limit. Callers that already passed admission — the queue drains — reach
   * this directly so drain never strips a message the manager already accepted.
   */
  private async admit(
    conversationId: string,
    message: QueuedMessage
  ): Promise<LockAcquisitionResult> {
    // Check if conversation already active - queue if yes
    if (this.activeConversations.has(conversationId)) {
      this.queueMessage(conversationId, message);
      return { status: 'queued-conversation', queuedId: message.id };
    }

    // Check if at max capacity - queue if yes
    if (this.activeConversations.size >= this.maxConcurrent) {
      getLog().info({ maxConcurrent: this.maxConcurrent, conversationId }, 'queued_at_capacity');
      this.queueMessage(conversationId, message);
      return { status: 'queued-capacity', queuedId: message.id };
    }

    // Execute immediately
    getLog().debug(
      { conversationId, active: this.activeConversations.size + 1, queued: this.getQueuedCount() },
      'conversation_started'
    );

    // Store Promise in Map BEFORE awaiting (prevents race conditions)
    const controller = new AbortController();
    const promise = message
      .handler({ signal: controller.signal })
      .catch(error => {
        getLog().error({ err: error, conversationId }, 'conversation_handler_error');
      })
      .finally(() => {
        // Clean up active conversation
        this.activeConversations.delete(conversationId);
        getLog().debug(
          { conversationId, active: this.activeConversations.size, queued: this.getQueuedCount() },
          'conversation_completed'
        );

        // Process next queued message for this conversation
        this.processQueue(conversationId).catch(error => {
          getLog().error({ err: error, conversationId }, 'queue_processing_error');
        });

        // Also check if we can process any other queued conversations (global capacity freed up)
        this.processGlobalQueue().catch(error => {
          getLog().error({ err: error }, 'global_queue_processing_error');
        });
      });

    this.activeConversations.set(conversationId, { promise, controller });

    // Fire-and-forget: don't await here, return immediately
    return { status: 'started' };
  }

  /**
   * Add message to conversation queue
   * @param conversationId - Unique conversation identifier
   * @param message - The message to queue, keeping the id and time it was accepted with
   */
  private queueMessage(conversationId: string, message: QueuedMessage): void {
    const queue = this.messageQueues.get(conversationId) ?? [];
    if (!this.messageQueues.has(conversationId)) {
      this.messageQueues.set(conversationId, queue);
    }
    queue.push(message);
    getLog().debug({ conversationId, queueLength: queue.length }, 'message_queued');
  }

  /**
   * Process next queued message for conversation if any exist
   * @param conversationId - Unique conversation identifier
   */
  private async processQueue(conversationId: string): Promise<void> {
    const queue = this.messageQueues.get(conversationId);
    if (!queue || queue.length === 0) {
      this.messageQueues.delete(conversationId);
      return;
    }

    // At capacity, leave the head where it is: processGlobalQueue starts it when a
    // slot frees. Shifting it into admit() would re-queue it at the TAIL, behind
    // messages sent after it.
    if (this.activeConversations.size >= this.maxConcurrent) return;

    const next = queue.shift();
    if (!next) return;
    const waitTime = Date.now() - next.timestamp;
    getLog().debug({ conversationId, waitTimeMs: waitTime }, 'queued_message_processing');

    // admit(), not acquireLock(): this message was accepted before drain began and the
    // sender was told so. Refusing it here would be the silent drop drain exists to
    // prevent — and it is what lets drain terminate, since queues only shrink.
    await this.admit(conversationId, next);
  }

  /**
   * End this conversation's running turn early.
   *
   * Aborts the signal the turn's handler was started with; the handler's
   * provider owns what "abort" means. The lock is NOT released here — it is
   * released when the handler actually returns, exactly as for a turn that ended
   * on its own, so a provider slow to honour the abort keeps the conversation
   * busy rather than letting a second turn start on top of it.
   *
   * @param reason - Becomes `signal.reason`, so the turn can tell why it ended.
   * @returns The turn's completion, or `undefined` when nothing was running.
   *   Queued messages are untouched; they are delivered once the turn ends.
   */
  interrupt(conversationId: string, reason?: unknown): Promise<void> | undefined {
    const turn = this.activeConversations.get(conversationId);
    if (!turn) return undefined;
    if (!turn.controller.signal.aborted) {
      getLog().info({ conversationId }, 'turn_interrupt_requested');
      turn.controller.abort(reason);
    }
    return turn.promise;
  }

  /**
   * Take a conversation's queued messages so a deploy can persist them, and mark
   * the conversation parked for the rest of this drain.
   *
   * Synchronous for the same reason as `withdraw`: it races `processQueue`, and a
   * message must never be both parked and delivered. `onWithdraw` does NOT run —
   * a parked message's staged files are delivered later, not discarded.
   *
   * All or nothing: one queued message without a `parkable` payload refuses the
   * whole conversation, because parking the rest would deliver them out of order.
   */
  takeForPark(conversationId: string): ParkTakeResult {
    const drain = this.currentDrain();
    if (!drain) return { status: 'refused', reason: 'not_draining' };
    const queue = this.messageQueues.get(conversationId) ?? [];
    if (queue.some(m => m.description?.parkable === undefined)) {
      return { status: 'refused', reason: 'unparkable_queued_turn' };
    }
    const taken = queue.splice(0, queue.length);
    this.messageQueues.delete(conversationId);
    drain.parkedConversations.add(conversationId);
    getLog().info({ conversationId, queued: taken.length }, 'conversation_parked');

    const restore = (): void => {
      if (taken.length > 0) {
        const current = this.messageQueues.get(conversationId) ?? [];
        this.messageQueues.set(conversationId, [...taken, ...current]);
      }
      this.currentDrain()?.parkedConversations.delete(conversationId);
      getLog().warn({ conversationId, queued: taken.length }, 'conversation_park_restored');
      if (!this.activeConversations.has(conversationId)) {
        this.processQueue(conversationId).catch((error: unknown) => {
          getLog().error({ err: error, conversationId }, 'queue_processing_error');
        });
      }
    };
    return {
      status: 'taken',
      active: this.activeConversations.has(conversationId),
      queued: taken.flatMap(m => (m.description?.parkable ? [m.description.parkable] : [])),
      restore,
    };
  }

  /** Conversations this drain parked. Empty when not draining. */
  getParkedConversationIds(nowMs = Date.now()): string[] {
    return [...(this.currentDrain(nowMs)?.parkedConversations ?? [])];
  }

  /** The id everything parked during this drain is recorded under. */
  getDrainId(nowMs = Date.now()): string | undefined {
    return this.currentDrain(nowMs)?.drainId;
  }

  /** The described messages waiting for this conversation, oldest first. */
  listQueued(conversationId: string): QueuedMessageInfo[] {
    const queue = this.messageQueues.get(conversationId) ?? [];
    return queue.flatMap(m => (m.description ? [toQueuedInfo(m, m.description)] : []));
  }

  /**
   * Take a queued message back before it is delivered.
   *
   * Synchronous on purpose: delivery removes a message from the same array in
   * `processQueue`, also without awaiting, so whichever of the two runs first
   * wins and the other sees it gone. There is no state in which a message is
   * both withdrawn and delivered.
   */
  withdraw(conversationId: string, id: string): WithdrawResult {
    const queue = this.messageQueues.get(conversationId);
    const index = queue?.findIndex(m => m.id === id && m.description !== undefined) ?? -1;
    if (!queue || index === -1) return { status: 'not-queued' };
    const [message] = queue.splice(index, 1);
    if (queue.length === 0) this.messageQueues.delete(conversationId);
    const description = message?.description;
    if (!message || !description) return { status: 'not-queued' };
    getLog().info({ conversationId, queuedId: id }, 'queued_message_withdrawn');
    description.onWithdraw?.().catch((error: unknown) => {
      getLog().warn({ err: error, conversationId, queuedId: id }, 'queued_withdraw_cleanup_failed');
    });
    return { status: 'withdrawn', message: toQueuedInfo(message, description) };
  }

  /**
   * Is this conversation executing a turn right now?
   *
   * The same membership `activeConversationIds` reports, asked about one id.
   * It exists because a client that lost the stream has no other way to learn
   * the current answer: the lock lives in this process's memory, the events
   * that narrate it are not replayed, and a turn that ended during the gap
   * ended silently. A queued message is deliberately NOT active — the lock
   * event that brackets a turn fires when the handler starts, and this must
   * say the same thing the event would have said.
   *
   * @param conversationId - Platform conversation identifier, the same id
   *   `acquireLock` was called with
   */
  isActive(conversationId: string): boolean {
    return this.activeConversations.has(conversationId);
  }

  /**
   * Get current concurrency statistics
   * @returns Current state for observability
   */
  getStats(): {
    active: number;
    queuedTotal: number;
    queuedByConversation: { conversationId: string; queuedMessages: number }[];
    maxConcurrent: number;
    activeConversationIds: string[];
  } {
    const queuedByConversation = Array.from(this.messageQueues.entries()).map(([id, queue]) => ({
      conversationId: id,
      queuedMessages: queue.length,
    }));

    return {
      active: this.activeConversations.size,
      queuedTotal: Array.from(this.messageQueues.values()).reduce((sum, q) => sum + q.length, 0),
      queuedByConversation,
      maxConcurrent: this.maxConcurrent,
      activeConversationIds: Array.from(this.activeConversations.keys()),
    };
  }

  /**
   * Helper to get total queued count
   */
  private getQueuedCount(): number {
    return Array.from(this.messageQueues.values()).reduce((sum, q) => sum + q.length, 0);
  }

  /**
   * Stop admitting new conversation turns so the process can be replaced.
   *
   * Unrelated to `drainResourceStartHost`, which drains queued triggers *into*
   * execution. This stops work entering.
   *
   * The budget is mandatory and expires on its own: a deploy that dies mid-drain must
   * not leave a box that refuses work forever. Re-requesting replaces the budget and
   * keeps the refusal count, so a deploy can extend its own wait.
   *
   * @param budgetSeconds - How long drain stays in effect before lapsing
   */
  beginDrain(budgetSeconds: number): DrainStatus {
    if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
      throw new RangeError(`drain budget must be a positive number of seconds: ${budgetSeconds}`);
    }
    const now = Date.now();
    const existing = this.currentDrain(now);
    const state: DrainState = {
      requestedAt: existing?.requestedAt ?? new Date(now).toISOString(),
      expiresAtMs: now + budgetSeconds * 1000,
      refusedCount: existing?.refusedCount ?? 0,
      drainId: existing?.drainId ?? randomUUID(),
      parkedConversations: existing?.parkedConversations ?? new Set<string>(),
    };
    this.drainState = state;
    getLog().warn(
      { budgetSeconds, active: this.activeConversations.size, queued: this.getQueuedCount() },
      'drain_requested'
    );
    return toDrainStatus(state);
  }

  /** Resume admitting work. Idempotent — a deploy's failure path calls it blind. */
  cancelDrain(): void {
    if (!this.drainState) return;
    this.drainState = undefined;
    getLog().warn('drain_cancelled');
  }

  /**
   * @param nowMs - Injectable clock; the budget lapses lazily on read rather than on a
   *   timer, so nothing has to be unref'd or cleared.
   */
  getDrainStatus(nowMs = Date.now()): DrainStatus | undefined {
    const state = this.currentDrain(nowMs);
    return state ? toDrainStatus(state) : undefined;
  }

  isDraining(nowMs = Date.now()): boolean {
    return this.currentDrain(nowMs) !== undefined;
  }

  /** The live drain state, lapsing an expired budget. Mutable so refusals can count. */
  private currentDrain(nowMs = Date.now()): DrainState | undefined {
    const state = this.drainState;
    if (!state) return undefined;
    if (nowMs >= state.expiresAtMs) {
      this.drainState = undefined;
      getLog().warn(
        { requestedAt: state.requestedAt, refusedCount: state.refusedCount },
        'drain_budget_expired'
      );
      return undefined;
    }
    return state;
  }

  /**
   * Process queued messages from any conversation when global capacity available
   */
  private async processGlobalQueue(): Promise<void> {
    // Check if we have capacity
    if (this.activeConversations.size >= this.maxConcurrent) {
      return;
    }

    // Find first conversation with queued messages that's not currently active
    for (const [convId, queue] of this.messageQueues.entries()) {
      if (queue.length > 0 && !this.activeConversations.has(convId)) {
        await this.processQueue(convId);
        break; // Process one at a time
      }
    }
  }
}
