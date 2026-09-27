/**
 * Web platform adapter implementing IPlatformAdapter with SSE stream management.
 * Bridge between the orchestrator and the React frontend via Server-Sent Events.
 */
import type { IWebPlatformAdapter, MessageMetadata, TurnResultInfo } from '@archon/core';
import type { MessageChunk } from '@archon/providers/types';
import { addMessage, attachUsageToLatestAssistantMessage } from '@archon/core/db/messages';
import { contextWindowFor } from '@archon/core/orchestrator/context-window';
import { createLogger } from '@archon/paths';
import { MessagePersistence } from './web/persistence';
import { SSETransport, DASHBOARD_STREAM, type SSEWriter } from './web/transport';
import { truncateToolOutput } from './web/truncate';
import { WorkflowEventBridge } from './web/workflow-bridge';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.web');
  return cachedLog;
}

/**
 * A tool's input, cut down to what a one-line description can use.
 *
 * Deliberately generic rather than an allowlist of the keys the console reads:
 * which keys matter is the console's business (`primitives/activity.ts`), and
 * naming them here would be the same knowledge in two places. Strings only,
 * each bounded, and few — a Write carries an entire file in `content`, and
 * this rides on a health check that is polled.
 */
export type ToolInputSnapshot = Record<string, string>;

const TOOL_INPUT_MAX_KEYS = 8;
const TOOL_INPUT_MAX_CHARS = 160;

function boundToolInput(input: Record<string, unknown> | undefined): ToolInputSnapshot {
  const out: ToolInputSnapshot = {};
  if (input === undefined) return out;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value === '') continue;
    out[key] = value.slice(0, TOOL_INPUT_MAX_CHARS);
    if (Object.keys(out).length >= TOOL_INPUT_MAX_KEYS) break;
  }
  return out;
}

export class WebAdapter implements IWebPlatformAdapter {
  /** Per-conversation tool call counter for unique SSE tool IDs */
  private toolCallCounter = new Map<string, number>();
  /**
   * Per-conversation running tool stack for SSE duration tracking.
   * Uses a Map of toolCallId → start info so parallel DAG nodes don't
   * overwrite each other (they share a conversationId).
   */
  private runningTools = new Map<
    string,
    Map<string, { toolCallId: string; name: string; startedAt: number; input: ToolInputSnapshot }>
  >();
  /**
   * The most recent tool each conversation invoked, running or finished.
   *
   * `runningTools` empties the instant a tool reports back, so on its own it
   * answers "what is it doing" only during a tool — and most tools finish in
   * well under the interval anything polls at. A reader watching the list saw
   * the fallback word almost always, which is the thing this was built to
   * replace. The last tool is still the truthful answer while the turn runs:
   * between two tools the agent is thinking about the one it just did.
   *
   * Cleared when the turn ends, so it can never describe a finished chat.
   */
  private lastTool = new Map<
    string,
    { name: string; input: ToolInputSnapshot; startedAt: number }
  >();

  constructor(
    private transport: SSETransport,
    private persistence: MessagePersistence,
    private workflowBridge: WorkflowEventBridge
  ) {}

  /**
   * Subscribe an SSE stream to a conversation. Existing subscribers keep
   * their connections — a second tab joins, it does not take over.
   */
  registerStream(conversationId: string, stream: SSEWriter): void {
    this.transport.registerStream(conversationId, stream);
  }

  removeStream(conversationId: string, stream: SSEWriter): void {
    this.transport.removeStream(conversationId, stream);
    // Tool tracking is per CONVERSATION, not per connection, so it may only be
    // discarded once the last client has gone. Clearing it while another tab is
    // still watching would strand that tab's in-flight tool cards.
    if (this.transport.hasActiveStream(conversationId)) return;
    // Clean up stale tool tracking state on SSE disconnect to prevent
    // spurious tool_result events on the next message to this conversation.
    this.runningTools.delete(conversationId);
    this.lastTool.delete(conversationId);
    this.toolCallCounter.delete(conversationId);
  }

  /**
   * Map a platform conversation ID to its database UUID for message persistence.
   */
  setConversationDbId(platformConversationId: string, dbId: string): void {
    this.persistence.setConversationDbId(platformConversationId, dbId);
  }

  async sendMessage(
    conversationId: string,
    message: string,
    metadata?: MessageMetadata
  ): Promise<void> {
    // The stream carries the same seam the buffered row gets, so a live view
    // that appends pieces as they arrive renders what a reload will show.
    const seam = this.persistence.appendText(conversationId, message, metadata);

    // Categories that are handled structurally in the web UI (not as chat messages)
    if (
      metadata?.category === 'tool_call_formatted' ||
      metadata?.category === 'isolation_context'
    ) {
      return;
    }

    // `category` rides the wire so the client segments messages from the same
    // typed signal `MessagePersistence.appendText` uses (persistence.ts), rather
    // than re-deriving it by pattern-matching the message text.
    const event = JSON.stringify({
      type: 'text',
      content: seam + message,
      isComplete: true,
      timestamp: Date.now(),
      ...(metadata?.category ? { category: metadata.category } : {}),
      ...(metadata?.workflowResult ? { workflowResult: metadata.workflowResult } : {}),
    });

    // Forward output to registered callback (for event bridge preview)
    this.workflowBridge.emitOutput(conversationId, message);

    await this.transport.emit(conversationId, event);

    // Workflow result arrives after the parent lock is released (background dispatch),
    // so it would never be flushed. Force persistence flush for these messages.
    if (metadata?.category === 'workflow_result') {
      this.persistence.flush(conversationId).catch((e: unknown) => {
        getLog().error({ conversationId, err: e }, 'workflow_result_flush_failed');
      });
    }
  }

  /**
   * Record what the turn cost, onto the message the turn produced.
   *
   * The hook has existed since Slack needed a cost footer; the web console
   * needs the same numbers for a different reason — `tokens.input` is gross
   * prompt input, which is how full the model's context was on this turn, and
   * that is the only honest basis for saying when a chat should be handed off.
   *
   * Persisted rather than emitted: a gauge that resets on reload is not a
   * gauge. The write is a flush-then-update because the reply is streamed and
   * stored as it arrives, while usage is only known once the turn ends.
   *
   * Never throws. A missing reading is a missing gauge, not a failed turn.
   */
  /**
   * Write what the turn has said so far, so a row added now lands after it.
   * Never throws: a late write reorders history, a failed turn loses it.
   */
  async flushAssistant(conversationId: string): Promise<void> {
    try {
      await this.persistence.flush(conversationId);
    } catch (error) {
      getLog().warn({ conversationId, err: error }, 'assistant_flush_failed');
    }
  }

  async sendResultFooter(conversationId: string, info: TurnResultInfo): Promise<void> {
    if (!info.tokens) return;
    try {
      await this.persistence.flush(conversationId);
      const dbId = this.persistence.conversationDbId(conversationId);
      if (dbId === undefined) return;
      const { input, output, cacheRead, cacheWrite } = info.tokens;
      const window = contextWindowFor(info.model);
      await attachUsageToLatestAssistantMessage(dbId, {
        ...(info.contextTokens === undefined ? {} : { context: info.contextTokens }),
        input,
        output,
        ...(cacheRead === undefined ? {} : { cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWrite }),
        ...(info.cost === undefined ? {} : { costUsd: info.cost }),
        ...(info.model === undefined ? {} : { model: info.model }),
        // What the provider was handed, after clamping — absent when it was
        // left to the SDK's default, so the console shows nothing rather than
        // a rung it cannot vouch for.
        ...(info.effort === undefined ? {} : { effort: info.effort }),
        // Resolved here so the console divides rather than looks up. An
        // unknown model writes no window, and the bar then declines to claim
        // a percentage at all.
        ...(window === null ? {} : { window }),
      });
    } catch (error) {
      getLog().warn({ conversationId, err: error }, 'result_footer_persist_failed');
    }
  }

  /**
   * Say something that outlives the socket.
   *
   * Flushes the assistant buffer FIRST. The buffer is what holds this turn's
   * reply, and it is written on its own schedule — so a notice inserted
   * without flushing races the reply it is about and lands above it, leaving
   * the reader an explanation that precedes the thing it explains.
   *
   * Then the same SSE frame `sendStructuredEvent` would have sent, so a
   * console watching live sees it immediately and a console opened later
   * reads it out of the history. One notice, both paths.
   */
  async sendDurableNotice(
    conversationId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.persistence.flush(conversationId);
      const dbId = this.persistence.conversationDbId(conversationId);
      if (dbId !== undefined) {
        await addMessage(dbId, 'system', content, metadata);
      } else {
        // No mapping means nothing has persisted for this conversation yet, so
        // there is no row to attach to. Live delivery below still happens.
        getLog().warn({ conversationId }, 'durable_notice_no_db_id');
      }
    } catch (error) {
      // The notice is worth less than the turn it follows. Losing the written
      // copy is survivable; failing the caller is not.
      getLog().warn({ conversationId, err: error }, 'durable_notice_persist_failed');
    }
    await this.sendStructuredEvent(conversationId, { type: 'system', content });
  }

  async sendStructuredEvent(conversationId: string, chunk: MessageChunk): Promise<void> {
    let event: string;

    if (chunk.type === 'tool' && chunk.toolName) {
      const now = Date.now();

      // Buffer tool call for direct chat persistence (message metadata)
      this.persistence.appendToolCall(conversationId, {
        name: chunk.toolName,
        input: chunk.toolInput ?? {},
      });

      // Prefer the SDK-provided stable ID (e.g. Claude `tool_use_id`); fall back to a
      // generated counter for clients that don't supply one (e.g. Codex). Stable IDs
      // guarantee tool_call/tool_result pair correctly under concurrent same-named tools.
      let toolCallId: string;
      if (chunk.toolCallId) {
        toolCallId = chunk.toolCallId;
      } else {
        const counter = (this.toolCallCounter.get(conversationId) ?? 0) + 1;
        this.toolCallCounter.set(conversationId, counter);
        toolCallId = `${conversationId}-tool-${String(counter)}`;
      }

      // Track this tool's start for duration computation (supports parallel DAG nodes)
      let convTools = this.runningTools.get(conversationId);
      if (!convTools) {
        convTools = new Map();
        this.runningTools.set(conversationId, convTools);
      }
      const boundedInput = boundToolInput(chunk.toolInput);
      convTools.set(toolCallId, {
        toolCallId,
        name: chunk.toolName,
        startedAt: now,
        input: boundedInput,
      });
      this.lastTool.set(conversationId, {
        name: chunk.toolName,
        input: boundedInput,
        startedAt: now,
      });
      this.announceActivity(conversationId, chunk.toolName, boundedInput, now);

      event = JSON.stringify({
        type: 'tool_call',
        toolCallId,
        name: chunk.toolName,
        input: chunk.toolInput ?? {},
        timestamp: now,
      });
    } else if (chunk.type === 'tool_result' && chunk.toolName) {
      const now = Date.now();
      // Find and remove the matching running tool entry. Prefer stable ID lookup
      // (correct under concurrent same-named tools), fall back to name reverse-scan
      // for clients that don't supply an ID.
      const convTools = this.runningTools.get(conversationId);
      let matchedToolCallId: string | undefined;
      let startedAt = now;
      if (convTools) {
        if (chunk.toolCallId && convTools.has(chunk.toolCallId)) {
          const t = convTools.get(chunk.toolCallId);
          if (t) {
            matchedToolCallId = chunk.toolCallId;
            startedAt = t.startedAt;
            convTools.delete(chunk.toolCallId);
          }
        } else {
          // Reverse iterate to match the most recent tool with this name
          for (const [id, t] of [...convTools.entries()].reverse()) {
            if (t.name === chunk.toolName) {
              matchedToolCallId = id;
              startedAt = t.startedAt;
              convTools.delete(id);
              break;
            }
          }
        }
      }
      if (!matchedToolCallId) {
        // Neither stable-ID lookup nor name reverse-scan found a match. The
        // SSE event still goes out, but the UI cannot pair it to a running
        // card and the entry (if any) will leak in runningTools. Surface this
        // so we can debug missing tool_call emissions.
        getLog().warn(
          {
            conversationId,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
          },
          'web_adapter.tool_result_unmatched'
        );
      }
      const duration = now - startedAt;
      // Persist tool output to DB
      try {
        this.persistence.appendToolResult(
          conversationId,
          chunk.toolName,
          chunk.toolOutput,
          duration
        );
      } catch (e: unknown) {
        getLog().error({ conversationId, err: e }, 'tool_result_persist_failed');
      }
      // Bound the SSE payload only — the DB write above keeps the full output
      event = JSON.stringify({
        type: 'tool_result',
        toolCallId: matchedToolCallId,
        name: chunk.toolName,
        output: truncateToolOutput(chunk.toolOutput),
        duration,
        timestamp: now,
      });
    } else if (chunk.type === 'thinking' && chunk.content) {
      // Written into the same buffered segment the reply's text lands in, so
      // the history carries it beside the text it preceded — see
      // `MessagePersistence.appendThinking`.
      this.persistence.appendThinking(conversationId, chunk.content);
      event = JSON.stringify({
        type: 'thinking',
        content: chunk.content,
        timestamp: Date.now(),
      });
    } else if (chunk.type === 'result' && chunk.sessionId) {
      event = JSON.stringify({
        type: 'session_info',
        sessionId: chunk.sessionId,
        timestamp: Date.now(),
      });
    } else if (chunk.type === 'workflow_dispatch') {
      event = JSON.stringify({
        type: 'workflow_dispatch',
        workerConversationId: chunk.workerConversationId,
        workflowName: chunk.workflowName,
        timestamp: Date.now(),
      });
    } else if (chunk.type === 'system') {
      event = JSON.stringify({
        type: 'system_status',
        content: chunk.content,
        timestamp: Date.now(),
      });
    } else {
      return;
    }

    await this.transport.emit(conversationId, event);
  }

  async ensureThread(originalConversationId: string): Promise<string> {
    return originalConversationId;
  }

  getStreamingMode(): 'stream' | 'batch' {
    return 'stream';
  }

  getPlatformType(): string {
    return 'web';
  }

  async start(): Promise<void> {
    this.workflowBridge.setStepTransitionCallback((workerConversationId: string) => {
      this.persistence.flush(workerConversationId).catch((e: unknown) => {
        getLog().error(
          { conversationId: workerConversationId, err: e },
          'step_transition_flush_failed'
        );
      });
    });
    this.workflowBridge.start();
    this.transport.start();
    this.persistence.startPeriodicFlush();
  }

  async stop(): Promise<void> {
    this.persistence.stopPeriodicFlush();
    await this.persistence.flushAll();
    this.transport.stop();
    this.workflowBridge.stop();
    this.persistence.clearAll();
    this.toolCallCounter.clear();
    this.runningTools.clear();
    this.lastTool.clear();
  }

  /**
   * Emit a lock event to the SSE stream for a conversation.
   * Called by API routes based on acquireLock() return status.
   */
  async emitLockEvent(
    conversationId: string,
    locked: boolean,
    queuePosition?: number
  ): Promise<void> {
    if (!locked) {
      // Finalize ALL running tools and emit tool_result for each before lock release
      const convTools = this.runningTools.get(conversationId);
      if (convTools && convTools.size > 0) {
        const now = Date.now();
        for (const tool of convTools.values()) {
          const duration = now - tool.startedAt;
          const resultEvent = JSON.stringify({
            type: 'tool_result',
            toolCallId: tool.toolCallId,
            name: tool.name,
            output: '',
            duration,
            timestamp: now,
          });
          await this.transport.emit(conversationId, resultEvent);
          // Persist fallback output to DB (real output may have been captured via PostToolUse hook)
          try {
            this.persistence.appendToolResult(conversationId, tool.name, '', duration);
          } catch (e: unknown) {
            getLog().error({ conversationId, err: e }, 'tool_result_persist_failed');
          }
        }
        this.runningTools.delete(conversationId);
      }
      // The turn is over, so there is no longer anything it is "doing".
      this.lastTool.delete(conversationId);
      // Finalize tool durations in persistence buffer before flushing to DB
      this.persistence.finalizeRunningTools(conversationId);
      await this.persistence.flush(conversationId).catch((e: unknown) => {
        getLog().error({ conversationId, err: e }, 'lock_release_flush_failed');
      });
    }
    // Use transport.emit() directly so the lock event is fully awaited and ordered after tool_results
    const lockEvent = JSON.stringify({
      type: 'conversation_lock',
      conversationId,
      locked,
      queuePosition,
      timestamp: Date.now(),
    });
    await this.transport.emit(conversationId, lockEvent);

    // Announce it on the dashboard stream too. The lock lives in this process's
    // memory, so a client that is looking at a DIFFERENT chat — or at the chat
    // list — has no way to learn that this one started or stopped working
    // except by asking /api/health on a timer. This is what makes that instant.
    // Fire-and-forget and unordered with respect to the stream above: the
    // console reads it purely as "ask again", never as state.
    if (this.transport.hasActiveStream(DASHBOARD_STREAM)) {
      this.transport.emitWorkflowEvent(DASHBOARD_STREAM, lockEvent);
    }
  }

  /**
   * Tell the dashboard what a conversation just started doing.
   *
   * The one event on this stream that CARRIES its answer instead of triggering
   * a refetch. Every other one is a trigger because the authority is a database
   * the client can re-read; this one's authority is a Map in this process, and
   * at one event per tool call a refetch each would be the busiest request the
   * console makes — to be told the thing the event already said.
   *
   * There is no matching "stopped" event, because a tool finishing does not
   * mean the conversation stopped doing anything: `lastTool` deliberately
   * survives a tool_result, so the row can say what it is between tools rather
   * than falling back to the word "working". What ends the activity is the turn
   * ending, and `emitLockEvent` already announces that.
   */
  private announceActivity(
    conversationId: string,
    name: string,
    input: ToolInputSnapshot,
    startedAt: number
  ): void {
    if (!this.transport.hasActiveStream(DASHBOARD_STREAM)) return;
    this.transport.emitWorkflowEvent(
      DASHBOARD_STREAM,
      JSON.stringify({
        type: 'conversation_activity',
        conversationId,
        name,
        // Already bounded to short strings by the caller — this is a line in a
        // rail, not a tool payload, and the console drops anything else.
        input,
        startedAt,
      })
    );
  }

  /**
   * What each conversation is doing right now: its newest still-running tool.
   *
   * Read from the same map that pairs tool_call with tool_result, so it is the
   * live truth rather than the newest PERSISTED message — which lags, and
   * during a long tool lags by the whole length of that tool. That is exactly
   * the stretch a reader most wants named.
   *
   * Newest wins when several are in flight: parallel tools share a
   * conversation, and one line can only say one thing.
   */
  currentActivity(): Map<string, { name: string; input: ToolInputSnapshot; startedAt: number }> {
    // Seed with the last tool of each turn, then let anything actually running
    // overwrite it. A tool in flight is the better answer; the last one is the
    // answer that is still true in the gaps between them.
    const out = new Map(this.lastTool);
    for (const [conversationId, tools] of this.runningTools) {
      let newest: { name: string; input: ToolInputSnapshot; startedAt: number } | undefined;
      for (const tool of tools.values()) {
        if (newest === undefined || tool.startedAt >= newest.startedAt) {
          newest = { name: tool.name, input: tool.input, startedAt: tool.startedAt };
        }
      }
      if (newest !== undefined) out.set(conversationId, newest);
    }
    return out;
  }

  hasActiveStream(conversationId: string): boolean {
    return this.transport.hasActiveStream(conversationId);
  }

  /**
   * Bridge workflow events from a worker conversation to a parent conversation's SSE stream.
   * Forwards compact progress events (step progress, status) and output previews.
   */
  setupEventBridge(workerConversationId: string, parentConversationId: string): () => void {
    return this.workflowBridge.bridgeWorkerEvents(workerConversationId, parentConversationId);
  }

  registerOutputCallback(conversationId: string, callback: (text: string) => void): void {
    this.workflowBridge.registerOutputCallback(conversationId, callback);
  }

  removeOutputCallback(conversationId: string): void {
    this.workflowBridge.removeOutputCallback(conversationId);
  }

  async emitRetract(conversationId: string): Promise<void> {
    // Remove retracted text from persistence buffer so it doesn't get written to DB
    this.persistence.retractLastSegment(conversationId);
    const event = JSON.stringify({
      type: 'retract',
      timestamp: Date.now(),
    });
    await this.transport.emit(conversationId, event);
  }

  async emitSSE(conversationId: string, event: string): Promise<void> {
    await this.transport.emit(conversationId, event);
  }
}
