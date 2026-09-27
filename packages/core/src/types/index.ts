/**
 * Core type definitions for the Remote Coding Agent platform
 */
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { RunModelOverrides } from '@archon/workflows/model-validation';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';

// MessageChunk + TokenUsage are used by IPlatformAdapter below.
import type { MessageChunk, TokenUsage } from '@archon/providers/types';

// Re-export schema-derived types so existing imports from '@archon/core/types' keep working.
export type {
  Conversation,
  IdentityPlatform,
  User,
  UserIdentity,
  UserRole,
  Codebase,
  Session,
  SessionMetadata,
} from '../schemas';
export { sessionMetadataSchema, identityPlatformSchema } from '../schemas';

/**
 * Custom error for when a conversation is not found during update operations
 * Allows callers to programmatically handle this specific error case
 */
export class ConversationNotFoundError extends Error {
  constructor(public conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = 'ConversationNotFoundError';
  }
}

import type { IsolationHints } from '@archon/isolation';

export interface AttachedFile {
  /** Absolute path on disk where the file was saved by the server */
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface HandleMessageContext {
  readonly issueContext?: string;
  readonly threadContext?: string;
  readonly parentConversationId?: string;
  readonly isolationHints?: IsolationHints;
  readonly attachedFiles?: AttachedFile[];
  /**
   * Archon user UUID resolved from the inbound platform user identifier.
   * Chat/forge adapters resolve this via findOrCreateUserByPlatformIdentity
   * before calling handleMessage. Undefined for web/CLI surfaces until their
   * own auth flows are wired.
   */
  readonly userId?: string;
  /**
   * Ends this chat turn early when aborted — the signal the conversation lock
   * manager started the turn with. Reaches the chat turn's own provider query
   * and nothing else: a workflow the turn dispatched runs under its own
   * lifecycle and keeps its own cancel.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Declared workflow inputs supplied by the caller (#2554), keyed by input name.
   *
   * Set ONLY by the `POST /api/workflows/:name/run` route, whose body carries an
   * `inputs` map. It rides the context rather than the message text so a supplied value
   * is never confused with `$ARGUMENTS`, and so chat platforms — which have no channel
   * for it and never populate this field — keep their existing behaviour unchanged
   * (#2555 tracks giving them one).
   */
  readonly workflowInputs?: Readonly<Record<string, string>>;
  /** Sparse tier/@alias rebindings supplied by the workflow run route (#2481). */
  readonly workflowModelOverrides?: RunModelOverrides;
  /** Validated inline config content supplied by the workflow run route. */
  readonly workflowRunConfig?: WorkflowRunConfigInput;
  /**
   * Between-run continuation (#2747): the terminal run this run adopts or
   * supersedes. Rides the context like `workflowInputs` so it can never be
   * confused with message text. Provenance is recorded engine-side; lane
   * resolution is the dispatching surface's job.
   */
  readonly workflowAdoptRunId?: string;
  readonly workflowSupersedesRunId?: string;
  /**
   * Set when the server, not a person, wrote this turn's message — today only
   * a CI watch firing. Such a turn does not withdraw the agent's "ready to
   * close" claim, which only a human message is evidence against.
   */
  readonly machineOrigin?: 'ci-watch';
}

export type WorkflowRequest =
  | {
      kind: 'start';
      definition: ResolvedWorkflow;
      args: string;
      force?: boolean;
      /** Keys the engine dropped from this workflow's YAML (#2213). */
      parseWarnings?: readonly string[];
    }
  | { kind: 'resume'; run: WorkflowRun };

export interface CommandResult {
  success: boolean;
  message: string;
  modified?: boolean; // Indicates if conversation state was modified
  /** If set, orchestrator should execute this workflow request. */
  workflow?: WorkflowRequest;
}

/**
 * Generic platform adapter interface
 * Allows supporting multiple platforms (Telegram, Slack, GitHub, etc.)
 */
export interface MessageMetadata {
  category?:
    | 'tool_call_formatted'
    | 'workflow_status'
    | 'workflow_dispatch_status'
    | 'isolation_context'
    | 'workflow_result';
  segment?: 'new' | 'auto';
  workflowDispatch?: { workerConversationId: string; workflowName: string };
  workflowResult?: { workflowName: string; runId: string };
  /**
   * What this turn cost, as the provider reported it.
   *
   * `input` is GROSS prompt input — cache reads and writes included — which is
   * the size of the prefix actually replayed, and therefore how full the
   * model's context was on this turn. It is an occupancy reading, not a
   * running total: it falls when the provider compacts, and that fall is the
   * only signal anyone gets that compaction happened.
   *
   * Lives on the newest assistant message rather than on the conversation
   * because that is what it describes. A chat has no single context size; each
   * turn has one.
   */
  usage?: {
    /**
     * How full the context was when the turn ended — gross input on the LAST
     * request. This is the figure the bar divides by `window`.
     *
     * Absent on readings written before the distinction existed, and on
     * providers that report no per-request usage. `input` is NOT a substitute:
     * it sums every request in the turn, so a tool-heavy turn reports millions.
     */
    context?: number;
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    costUsd?: number;
    /** The model that answered. Without it the reading has no denominator. */
    model?: string;
    /**
     * That model's context window, resolved where the model is known.
     *
     * Written here rather than looked up by every reader: the table belongs to
     * one place (orchestrator/context-window.ts), and a client that divides a
     * number it was handed cannot disagree with the server about how full a
     * conversation is. Absent when the model is unrecognised, which is what
     * makes "no percentage" possible instead of a guessed one.
     */
    window?: number;
  };
}

export { toPersistedMessageMetadata } from './message-metadata';

export interface IPlatformAdapter {
  /**
   * Send a message to the platform
   */
  sendMessage(conversationId: string, message: string, metadata?: MessageMetadata): Promise<void>;

  /**
   * Ensure responses go to a thread, creating one if needed.
   * Returns the thread's conversation ID to use for subsequent messages.
   *
   * @param originalConversationId - The conversation ID from the triggering message
   * @param messageContext - Platform-specific context (e.g., Discord Message, Slack event)
   * @returns Thread conversation ID (may be same as original if already in thread)
   */
  ensureThread(originalConversationId: string, messageContext?: unknown): Promise<string>;

  /**
   * Get the configured streaming mode
   */
  getStreamingMode(): 'stream' | 'batch';

  /**
   * Get the platform type identifier (e.g., 'telegram', 'github', 'slack')
   */
  getPlatformType(): string;

  /**
   * Start the platform adapter (e.g., begin polling, start webhook server)
   */
  start(): Promise<void>;

  /**
   * Stop the platform adapter gracefully
   */
  stop(): void;

  /**
   * Optional: Send a structured event (MessageChunk) to the platform.
   * Only implemented by adapters that can display rich structured data (e.g., Web UI).
   * Other adapters (Telegram, Slack) continue using sendMessage() for formatted text.
   */
  sendStructuredEvent?(conversationId: string, event: MessageChunk): Promise<void>;

  /**
   * Optional: say something that has to survive a reload.
   *
   * `sendStructuredEvent` is a live wire — the web adapter turns a `system`
   * chunk into an SSE frame and nothing writes it down. That is right for the
   * traffic it carries (compaction notices, task lists, transient warnings,
   * and at least one deliberately empty string): a status that outlived its
   * moment would be clutter in every transcript.
   *
   * It is wrong for the handful of notices that explain something permanent.
   * A chat that handed itself off at 3am leaves an archived conversation and a
   * document; without a durable line saying why, the reader finds the result
   * and never the reason — and the unattended case is exactly the one where
   * nobody saw the live frame.
   *
   * So durability is the CALLER's decision, because only the caller knows
   * whether the thing it is saying is a status or a fact.
   */
  sendDurableNotice?(
    conversationId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /** Retract previously streamed text (used when workflow routing intercepts) */
  emitRetract?(conversationId: string): Promise<void>;

  /**
   * Optional: how an operator types a workflow command on this surface, given the
   * command after the verb prefix (`cancel <id>`). Absent means the chat grammar the
   * core command handler parses, `/workflow <command>`.
   */
  formatWorkflowCommand?(command: string): string;

  /**
   * Optional: Append a small footer summarising cost / token usage / stop reason
   * after a direct-chat assistant turn. Implemented by adapters that surface
   * usage info in-band (e.g. Slack posts an italic context line). No-op for
   * adapters that don't care; orchestrator skips the call when both `cost`
   * and `tokens` are absent.
   */
  sendResultFooter?(conversationId: string, info: TurnResultInfo): Promise<void>;
}

/**
 * What a finished direct-chat turn reports about itself, for `sendResultFooter`.
 *
 * One declaration because the orchestrator builds it in two modes and hands it
 * to every adapter; inline copies of the shape drifted the moment a field was
 * added to one of them.
 */
export interface TurnResultInfo {
  cost?: number;
  tokens?: TokenUsage;
  contextTokens?: number;
  stopReason?: string;
  /** The model that answered — reported by the provider, else the one it was handed. */
  model?: string;
  /** The reasoning effort the provider handed its SDK, after clamping. */
  effort?: string;
}

/**
 * Extended platform adapter for the Web UI.
 * Adds methods for SSE event bridging, message persistence, and lock events
 * that are only meaningful in the web context.
 */
export interface IWebPlatformAdapter extends IPlatformAdapter {
  sendStructuredEvent(conversationId: string, event: MessageChunk): Promise<void>;
  setConversationDbId(platformConversationId: string, dbId: string): void;
  setupEventBridge(workerConversationId: string, parentConversationId: string): () => void;
  emitLockEvent(conversationId: string, locked: boolean, queuePosition?: number): Promise<void>;
  registerOutputCallback(conversationId: string, callback: (text: string) => void): void;
  removeOutputCallback(conversationId: string): void;
}

/**
 * Type guard for web platform adapter.
 */
export function isWebAdapter(adapter: IPlatformAdapter): adapter is IWebPlatformAdapter {
  return adapter.getPlatformType() === 'web';
}

// Re-export workflow schema types for config-types.ts compatibility
import type { ModelReasoningEffort, WebSearchMode } from '@archon/workflows/schemas/workflow';
export type { ModelReasoningEffort, WebSearchMode };
import type { EffortLevel, SandboxSettings } from '@archon/workflows/schemas/dag-node';
export type { EffortLevel, SandboxSettings };
