/**
 * AI-powered conversation title generator
 *
 * Generates concise 3-6 word titles using the configured AI assistant.
 * Optionally uses TITLE_GENERATION_MODEL env var for a cheaper/faster model.
 * Designed to be fire-and-forget — never throws, all errors logged internally.
 */
import { getAgentProvider } from './provider-admission';
import type { SendQueryOptions } from '@archon/providers/types';
import * as conversationDb from '../db/conversations';
import * as messageDb from '../db/messages';
import type { MessageRow } from '../schemas/message';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('service.title-generator');
  return cachedLog;
}

/** Maximum title length in the database */
const MAX_TITLE_LENGTH = 100;

/**
 * User turns between automatic re-title checks.
 *
 * Ten, because a title earns its keep by being stable: the rail is how a chat
 * is found again, and a name that moves every few messages is worse than one
 * that is slightly stale. It also bounds the cost to one small-tier call per
 * ten user messages per chat.
 */
const RETITLE_EVERY_N_TURNS = 10;

/** Recent messages shown to the drift check. Enough to see the topic, not the history. */
const RETITLE_CONTEXT_MESSAGES = 20;

/**
 * Generate and save a conversation title using AI.
 *
 * Fire-and-forget safe — catches all errors internally.
 *
 * @param conversationDbId - Database UUID of the conversation
 * @param userMessage - The user's message to generate a title from
 * @param assistantType - Provider identifier (e.g. 'claude', 'codex')
 * @param cwd - Working directory for the AI client
 * @param workflowName - Optional workflow name for additional context
 * @param assistantConfig - Optional provider-specific defaults for the selected assistant
 * @param requestOptions - Optional fully resolved request options from the caller
 */
export async function generateAndSetTitle(
  conversationDbId: string,
  userMessage: string,
  assistantType: string,
  cwd: string,
  workflowName?: string,
  assistantConfig?: Record<string, unknown>,
  requestOptions?: SendQueryOptions
): Promise<void> {
  try {
    getLog().debug({ conversationDbId, assistantType }, 'title.generate_started');

    // TITLE_GENERATION_MODEL is an emergency literal override for operators.
    // Normal title generation should be resolved by the caller to the `small` tier.
    const titleModel = process.env.TITLE_GENERATION_MODEL || undefined;

    // Build the title generation prompt
    const titlePrompt = buildTitlePrompt(userMessage, workflowName);

    // Use the configured AI client with no tools (pure text generation)
    const client = getAgentProvider(assistantType);
    let generatedTitle = '';

    const options: SendQueryOptions = {
      ...(requestOptions ?? {}),
      ...(titleModel ? { model: titleModel } : {}),
      assistantConfig: requestOptions?.assistantConfig ?? assistantConfig,
      nodeConfig: {
        ...(requestOptions?.nodeConfig ?? {}),
        allowed_tools: [], // No tool access — pure text generation
      },
    };

    for await (const chunk of client.sendQuery(titlePrompt, cwd, undefined, options)) {
      if (chunk.type === 'assistant') {
        generatedTitle += chunk.content;
      }
    }

    // Clean up the generated title
    const title = cleanTitle(generatedTitle);

    if (!title) {
      getLog().warn({ conversationDbId, raw: generatedTitle }, 'title.generate_empty');
      const fallback = truncateMessage(userMessage);
      await setGeneratedTitle(conversationDbId, fallback);
      return;
    }

    if (await setGeneratedTitle(conversationDbId, title)) {
      getLog().info({ conversationDbId, title }, 'title.generate_completed');
    }
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, conversationDbId }, 'title.generate_failed');
    // Fire-and-forget — do NOT re-throw.
    // Fallback: try to set a truncated message title
    try {
      const fallback = truncateMessage(userMessage);
      if (await setGeneratedTitle(conversationDbId, fallback)) {
        getLog().info({ conversationDbId, title: fallback }, 'title.fallback_set');
      }
    } catch (_fallbackErr: unknown) {
      // Double failure — just log and move on
      getLog().warn({ conversationDbId }, 'title.fallback_also_failed');
    }
  }
}

/**
 * Write a generated title unless a person has pinned one meanwhile.
 *
 * The first title is generated after a model call that takes seconds, and the
 * chat is often renamed inside that window (a spawned chat is renamed the
 * moment it exists). The pin check therefore lives in the write, not here.
 */
async function setGeneratedTitle(conversationDbId: string, title: string): Promise<boolean> {
  const written = await conversationDb.updateConversationTitle(
    conversationDbId,
    title,
    'automation'
  );
  if (!written) getLog().debug({ conversationDbId }, 'title.generate_skipped_pinned');
  return written;
}

/**
 * Build the prompt for title generation
 */
function buildTitlePrompt(userMessage: string, workflowName?: string): string {
  const context = workflowName ? `\nWorkflow: ${workflowName}` : '';

  return `Generate a concise conversation title (3-6 words) for this user message. The title should capture the essence of what the user is asking or doing. Return ONLY the title text, nothing else — no quotes, no punctuation at the end, no explanation.
${context}
User message: ${userMessage.slice(0, 500)}`;
}

/**
 * Clean up the AI-generated title
 * - Strip quotes, extra whitespace, trailing punctuation
 * - Enforce length limit
 */
function cleanTitle(raw: string): string {
  let cleaned = raw
    .trim()
    .replace(/^["']|["']$/g, '') // Strip surrounding quotes
    .replace(/^Title:\s*/i, '') // Strip "Title: " prefix
    .replace(/[.!?]+$/, '') // Strip trailing punctuation
    .replace(/\n.*/s, '') // Take only first line
    .trim();

  if (cleaned.length > MAX_TITLE_LENGTH) {
    cleaned = cleaned.slice(0, MAX_TITLE_LENGTH - 3) + '...';
  }

  return cleaned;
}

/**
 * Truncate a user message for use as a fallback title
 */
function truncateMessage(message: string): string {
  return message.length > MAX_TITLE_LENGTH
    ? message.slice(0, MAX_TITLE_LENGTH - 3) + '...'
    : message;
}

/**
 * Reconsider a chat's title once its topic has moved on.
 *
 * A title is generated from the FIRST message and then never revisited, so a
 * long conversation carries the name of whatever opened it. This chat is the
 * example: it began with frozen counts in the project rail and became an SSE
 * transport fix, several deploys and a credential cleanup, under its original
 * name throughout. The rail is the main way a chat is found, so the name being
 * the oldest fact about it is the wrong fact to keep.
 *
 * Three things keep this cheap and safe:
 *
 * - It is gated on turn count, not run every turn. One small-tier call per
 *   `RETITLE_EVERY_N_TURNS` user messages, not per message.
 * - It is given the recent conversation, not the latest message. Titling from
 *   the newest message alone is the same mistake as titling from the first,
 *   moved to the other end — it would rename a long chat after whatever was
 *   said in the last two minutes.
 * - The model decides drift, not a heuristic. It answers `KEEP` when the title
 *   still fits, which is the common case and costs one short reply.
 *
 * Never re-titles a pinned chat. Pass `force` for an explicit user request —
 * `/retitle` — which overrides the pin, because the rule is that automation
 * respects a human's rename and a direct instruction does not have to.
 *
 * Fire-and-forget safe: catches everything, and on any doubt leaves the
 * existing title alone. A wrong rename is worse than a stale one.
 */
export async function reconsiderConversationTitle(
  conversationDbId: string,
  assistantType: string,
  cwd: string,
  opts?: { force?: boolean; requestOptions?: SendQueryOptions }
): Promise<void> {
  try {
    const conversation = await conversationDb.getConversationById(conversationDbId);
    if (!conversation) return;

    const force = opts?.force === true;
    const current = conversation.title ?? '';
    if (!current) return; // Never titled — that is generateAndSetTitle's job.
    if (conversation.title_pinned === true && !force) {
      getLog().debug({ conversationDbId }, 'title.retitle_skipped_pinned');
      return;
    }

    const messages = await messageDb.listMessages(conversationDbId, RETITLE_CONTEXT_MESSAGES);
    const userTurns = messages.filter(m => m.role === 'user').length;
    // An explicit request is answered whatever the turn count; the automatic
    // path waits for a boundary so this is not a model call on every message.
    if (!force && (userTurns < RETITLE_EVERY_N_TURNS || userTurns % RETITLE_EVERY_N_TURNS !== 0)) {
      return;
    }
    if (messages.length === 0) return;

    const titleModel = process.env.TITLE_GENERATION_MODEL || undefined;
    const client = getAgentProvider(assistantType);
    const options: SendQueryOptions = {
      ...(opts?.requestOptions ?? {}),
      ...(titleModel ? { model: titleModel } : {}),
      nodeConfig: {
        ...(opts?.requestOptions?.nodeConfig ?? {}),
        allowed_tools: [],
      },
    };

    let raw = '';
    for await (const chunk of client.sendQuery(
      buildRetitlePrompt(current, messages),
      cwd,
      undefined,
      options
    )) {
      if (chunk.type === 'assistant') raw += chunk.content;
    }

    const answer = cleanTitle(raw);
    // KEEP is the expected answer, so treat anything that looks like it as a
    // decision to keep rather than as a title someone would have to read.
    if (!answer || /^keep\b/i.test(answer)) {
      getLog().debug({ conversationDbId }, 'title.retitle_kept');
      return;
    }
    if (answer.toLowerCase() === current.toLowerCase()) return;

    // The pin read above can be stale by now — a rename may have landed during
    // the model call — so the automatic write re-checks it atomically.
    const written = await conversationDb.updateConversationTitle(
      conversationDbId,
      answer,
      force ? 'request' : 'automation'
    );
    if (!written) {
      getLog().debug({ conversationDbId }, 'title.retitle_skipped_pinned');
      return;
    }
    getLog().info({ conversationDbId, from: current, to: answer }, 'title.retitled');
  } catch (error) {
    // Fire-and-forget — the existing title stands.
    getLog().warn({ err: error as Error, conversationDbId }, 'title.retitle_failed');
  }
}

/**
 * Build the drift prompt.
 *
 * It states the current title and asks for a verdict, rather than asking for a
 * title and comparing afterwards. Asking "what should this be called" always
 * returns a name, and every one of those would be a rename.
 */
function buildRetitlePrompt(currentTitle: string, messages: readonly MessageRow[]): string {
  const transcript = messages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 400)}`)
    .join('\n');

  return `A chat is currently titled "${currentTitle}". Below is its recent conversation.

If that title still describes what this chat is about, reply with exactly: KEEP

Only if the topic has clearly moved on to something the title no longer covers, reply with a better title of 3-6 words. Return ONLY the title text — no quotes, no explanation, no trailing punctuation.

Prefer KEEP. A title that is merely imperfect is not worth changing; renaming a chat moves it in the reader's memory.

Recent conversation:
${transcript}`;
}
