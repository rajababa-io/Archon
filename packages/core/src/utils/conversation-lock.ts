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
import type { MidTurnInbox, MidTurnMessage } from '@archon/providers';

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
  /**
   * Where messages sent into this turn while it runs arrive. The turn opens it
   * only if its provider can take them; until then `steer` refuses, so a
   * message is never promised to a turn that cannot read it.
   */
  inbox: MidTurnInput;
}

/** What a turn's handler can do with its inbox: open it for a provider that reads it. */
export interface MidTurnInput {
  open(): MidTurnInbox;
}

/**
 * The running turn's end of "send now". Holds pointers to queued messages, not
 * the messages: the queue stays the authority until the provider reports one
 * landed, so a message the turn never reads is still delivered — as the next
 * turn, exactly as if it had never been steered.
 */
export class TurnInbox implements MidTurnInbox, MidTurnInput {
  private buffered: MidTurnMessage[] = [];
  private waiting: ((message: MidTurnMessage | null) => void) | undefined;
  private isOpen = false;
  private isClosed = false;

  constructor(
    private readonly onOpen: () => void,
    private readonly onLanded: (id: string) => void
  ) {}

  /** Called by a turn whose provider takes mid-turn input. */
  open(): MidTurnInbox {
    if (!this.isOpen && !this.isClosed) {
      this.isOpen = true;
      this.onOpen();
    }
    return this;
  }

  get accepting(): boolean {
    return this.isOpen && !this.isClosed;
  }

  /** False when the turn cannot take it; the message then simply stays queued. */
  push(message: MidTurnMessage): boolean {
    if (!this.accepting) return false;
    const waiter = this.waiting;
    this.waiting = undefined;
    if (waiter) waiter(message);
    else this.buffered.push(message);
    return true;
  }

  next(): Promise<MidTurnMessage | null> {
    if (this.isClosed) return Promise.resolve(null);
    const head = this.buffered.shift();
    if (head) return Promise.resolve(head);
    return new Promise(resolve => {
      this.waiting = resolve;
    });
  }

  landed(id: string): void {
    if (!this.isClosed) this.onLanded(id);
  }

  /** The turn is over. Anything not yet landed is still in the queue. */
  close(): void {
    this.isClosed = true;
    this.buffered = [];
    const waiter = this.waiting;
    this.waiting = undefined;
    waiter?.(null);
  }
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
  /** Sent into the running turn and not yet read by the agent. */
  steering: boolean;
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
   * Runs when the message is read inside the running turn instead of waiting
   * for its own — the moment it belongs in the transcript. Never runs for a
   * message delivered as its own turn.
   */
  onLanded?: () => Promise<void>;
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
 * Where a turn came from. `replay` is parked work a deploy is handing back: it
 * runs ahead of every `new` message, because it was sent before any of them.
 */
export type TurnOrigin = 'new' | 'replay';

/**
 * Represents a queued message waiting for processing
 */
interface QueuedMessage {
  id: string;
  handler: TurnHandler;
  timestamp: number;
  origin: TurnOrigin;
  description?: QueueDescription;
  /** Handed to the running turn's inbox; cleared if that turn ends without reading it. */
  steering?: boolean;
}

/** A turn executing now, the switch that ends it early, and where "send now" goes. */
interface ActiveTurn {
  promise: Promise<void>;
  controller: AbortController;
  inbox: TurnInbox;
}

/**
 * The answer to "send this queued message into the running turn". `sent` means
 * handed over, not read: the message stays queued until it lands, and is
 * delivered as the next turn if it never does.
 */
export type SteerResult =
  | { status: 'sent' }
  | { status: 'not-queued' }
  /** Nothing running, its provider cannot take a message mid-turn, or the conversation still owes a replay. */
  | { status: 'not-accepting' }
  /** Attachments cannot ride into a running turn; the message waits for its own. */
  | { status: 'has-files' };

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
  /**
   * When the deploy will park what is still running, if it said. The deploy
   * owns its grace window; this only repeats what it declared, so the console
   * can count down to the moment chats are paused (#211).
   */
  parkAt?: string;
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
  parkAtMs?: number;
}

function toDrainStatus(state: DrainState): DrainStatus {
  return {
    requestedAt: state.requestedAt,
    expiresAt: new Date(state.expiresAtMs).toISOString(),
    refusedCount: state.refusedCount,
    ...(state.parkAtMs !== undefined ? { parkAt: new Date(state.parkAtMs).toISOString() } : {}),
  };
}

function toQueuedInfo(message: QueuedMessage, description: QueueDescription): QueuedMessageInfo {
  return {
    id: message.id,
    text: description.text,
    files: description.files ?? [],
    queuedAt: new Date(message.timestamp).toISOString(),
    steering: message.steering === true,
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
   * Conversations a drain parked that has since ended, whose parked work is not
   * yet handed back. Their new messages queue behind the replay instead of
   * starting — outliving the drain is the point, since un-parking ends the drain
   * before the replay reaches them.
   */
  private awaitingReplay = new Set<string>();
  /** Told when a turn starts accepting mid-turn input or a steered message lands. */
  private queueListener: ((conversationId: string) => void) | undefined;

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
   * @param origin - `replay` only for parked work being handed back
   */
  async acquireLock(
    conversationId: string,
    handler: TurnHandler,
    description?: QueueDescription,
    origin: TurnOrigin = 'new'
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
      origin,
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
    // Queue if the conversation is busy, or still owes a replay this message must follow
    if (this.activeConversations.has(conversationId) || !this.mayStart(conversationId, message)) {
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
    const inbox = new TurnInbox(
      () => {
        this.queueListener?.(conversationId);
      },
      id => {
        this.land(conversationId, id);
      }
    );
    const promise = message
      .handler({ signal: controller.signal, inbox })
      .catch(error => {
        getLog().error({ err: error, conversationId }, 'conversation_handler_error');
      })
      .finally(() => {
        // Clean up active conversation
        this.activeConversations.delete(conversationId);
        inbox.close();
        // Steered but never read: back to an ordinary queued message, delivered
        // next as its own turn.
        for (const m of this.messageQueues.get(conversationId) ?? []) m.steering = false;
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

    this.activeConversations.set(conversationId, { promise, controller, inbox });

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
    const firstNew = message.origin === 'replay' ? queue.findIndex(m => m.origin === 'new') : -1;
    if (firstNew === -1) queue.push(message);
    else queue.splice(firstNew, 0, message);
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
    // Same reason: a held head stays put until its conversation's replay is done.
    if (queue[0] && !this.mayStart(conversationId, queue[0])) return;

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
    // A steered message may already be in the agent's hands; it cannot be
    // taken back, only read or — if the turn ends first — delivered next.
    const index =
      queue?.findIndex(m => m.id === id && m.description !== undefined && m.steering !== true) ??
      -1;
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

  /** Report turns opening their inbox and steered messages landing. */
  setQueueListener(listener: (conversationId: string) => void): void {
    this.queueListener = listener;
  }

  /** Can a queued message be sent into this conversation's running turn right now? */
  acceptsSteer(conversationId: string): boolean {
    return (
      !this.awaitingReplay.has(conversationId) &&
      this.activeConversations.get(conversationId)?.inbox.accepting === true
    );
  }

  /**
   * Send a queued message into the running turn instead of waiting for it to
   * end. Synchronous, like `withdraw`, so it cannot interleave with delivery.
   */
  steer(conversationId: string, id: string): SteerResult {
    const message = this.messageQueues
      .get(conversationId)
      ?.find(m => m.id === id && m.description !== undefined);
    if (!message?.description) return { status: 'not-queued' };
    if (message.steering === true) return { status: 'sent' };
    if ((message.description.files ?? []).length > 0) return { status: 'has-files' };
    // Only a replay can be running while held; steering into it would jump the backlog
    if (!this.mayStart(conversationId, message)) return { status: 'not-accepting' };
    const turn = this.activeConversations.get(conversationId);
    if (!turn?.inbox.push({ id, text: message.description.text })) {
      return { status: 'not-accepting' };
    }
    message.steering = true;
    getLog().info({ conversationId, queuedId: id }, 'queued_message_steered');
    return { status: 'sent' };
  }

  /** The running turn read a steered message: it leaves the queue for the transcript. */
  private land(conversationId: string, id: string): void {
    const queue = this.messageQueues.get(conversationId);
    const index = queue?.findIndex(m => m.id === id && m.steering === true) ?? -1;
    if (!queue || index === -1) return;
    const [message] = queue.splice(index, 1);
    if (queue.length === 0) this.messageQueues.delete(conversationId);
    getLog().info({ conversationId, queuedId: id }, 'steered_message_landed');
    // Announced after the landing is written, so a client refetching on the
    // announcement finds the message in the history, not just gone from the queue.
    void (message?.description?.onLanded?.() ?? Promise.resolve())
      .catch((error: unknown) => {
        getLog().error({ err: error, conversationId, queuedId: id }, 'steered_landing_failed');
      })
      .finally(() => {
        this.queueListener?.(conversationId);
      });
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
   * @param graceSeconds - When the deploy says it will park what is left, counted
   *   from the drain's first request. Informational: nothing here parks on it.
   */
  beginDrain(budgetSeconds: number, graceSeconds?: number): DrainStatus {
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
    if (graceSeconds !== undefined) {
      state.parkAtMs = Date.parse(state.requestedAt) + graceSeconds * 1000;
    } else if (existing?.parkAtMs !== undefined) {
      state.parkAtMs = existing.parkAtMs;
    }
    this.drainState = state;
    getLog().warn(
      { budgetSeconds, active: this.activeConversations.size, queued: this.getQueuedCount() },
      'drain_requested'
    );
    return toDrainStatus(state);
  }

  /**
   * Resume admitting work. Idempotent — a deploy's failure path calls it blind.
   * What the drain parked stays held until `releaseReplayHolds`.
   */
  cancelDrain(): void {
    if (!this.drainState) return;
    this.endDrain(this.drainState);
    getLog().warn('drain_cancelled');
  }

  /**
   * End the hold on every conversation awaiting replay except those still owed
   * parked work, and start what queued behind it.
   *
   * @param stillOwed - Conversations with parked work not yet handed back
   */
  releaseReplayHolds(stillOwed: ReadonlySet<string>): void {
    for (const conversationId of [...this.awaitingReplay]) {
      if (stillOwed.has(conversationId)) continue;
      this.awaitingReplay.delete(conversationId);
      getLog().info({ conversationId }, 'replay_hold_released');
      if (!this.activeConversations.has(conversationId)) {
        this.processQueue(conversationId).catch((error: unknown) => {
          getLog().error({ err: error, conversationId }, 'queue_processing_error');
        });
      }
    }
  }

  private endDrain(state: DrainState): void {
    this.drainState = undefined;
    for (const conversationId of state.parkedConversations) {
      this.awaitingReplay.add(conversationId);
    }
  }

  /** A `new` message may not start while its conversation still owes a replay. */
  private mayStart(conversationId: string, message: QueuedMessage): boolean {
    return message.origin === 'replay' || !this.awaitingReplay.has(conversationId);
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
      this.endDrain(state);
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

    // Find first conversation with a startable queued message that's not currently active
    for (const [convId, queue] of this.messageQueues.entries()) {
      const head = queue[0];
      if (head && !this.activeConversations.has(convId) && this.mayStart(convId, head)) {
        await this.processQueue(convId);
        break; // Process one at a time
      }
    }
  }
}
