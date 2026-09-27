/**
 * A suggested next message for the chat box — what the user will most likely
 * type next ("run the tests", "open the PR").
 *
 * Bounded on every axis, because it runs after every finished web turn:
 * - the `small` tier, chosen by the caller, with no tools and no session;
 * - only the last exchange, truncated, as context;
 * - one short line out, or nothing;
 * - a hard time limit.
 *
 * Advisory by construction. Any failure — a refusal, a timeout, an empty or
 * over-long answer — yields `null`, and the caller shows nothing. A suggestion
 * is never sent; the user has to take it and press Enter.
 */
import type { SendQueryOptions } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import { getAgentProvider } from './provider-admission';
import { blockSeam } from '@archon/providers/block-seam';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('next-message-suggester');
  return cachedLog;
}

const MAX_USER_CHARS = 1500;
const MAX_REPLY_CHARS = 4000;
const MAX_SUGGESTION_CHARS = 160;
const TIME_LIMIT_MS = 20_000;
/** What the model answers when no next step is obvious. */
const NO_SUGGESTION = 'NONE';

export interface NextMessageSuggestion {
  text: string;
  /** What generating it cost, when the provider reports it. */
  costUsd?: number;
}

/** Keep the END of the reply: that is where an agent says what it did and what is next. */
function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

export function buildSuggestionPrompt(userMessage: string, reply: string): string {
  const user =
    userMessage.length <= MAX_USER_CHARS ? userMessage : `${userMessage.slice(0, MAX_USER_CHARS)}…`;
  return [
    'Predict the next message the user will send to their coding agent in this chat.',
    '',
    'Rules:',
    '- Write it as the user would type it: short, imperative, at most 12 words.',
    '- Only suggest a step that clearly follows from the exchange below.',
    `- If no next step is obvious, answer exactly ${NO_SUGGESTION}.`,
    '- Output only the message itself — no quotes, no explanation, no preamble.',
    '',
    '<user_message>',
    user,
    '</user_message>',
    '',
    '<agent_reply>',
    tail(reply, MAX_REPLY_CHARS),
    '</agent_reply>',
  ].join('\n');
}

/** One line, unquoted, within bounds — or null when there is nothing worth offering. */
export function cleanSuggestion(raw: string): string | null {
  const firstLine = raw.trim().split('\n')[0]?.trim() ?? '';
  const unquoted = firstLine.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
  if (unquoted.length === 0 || unquoted.toUpperCase() === NO_SUGGESTION) return null;
  if (unquoted.length > MAX_SUGGESTION_CHARS) return null;
  return unquoted;
}

/**
 * Ask the small tier for a next message. Never throws.
 *
 * @param provider - The provider the caller resolved the `small` tier to.
 * @param requestOptions - The caller's small-tier options (model, credentials).
 */
export async function suggestNextMessage(
  provider: string,
  cwd: string,
  userMessage: string,
  reply: string,
  requestOptions: SendQueryOptions
): Promise<NextMessageSuggestion | null> {
  if (reply.trim().length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIME_LIMIT_MS);
  try {
    const options: SendQueryOptions = {
      ...requestOptions,
      abortSignal: controller.signal,
      nodeConfig: { ...(requestOptions.nodeConfig ?? {}), allowed_tools: [] },
    };
    let text = '';
    let costUsd: number | undefined;
    const client = getAgentProvider(provider);
    for await (const chunk of client.sendQuery(
      buildSuggestionPrompt(userMessage, reply),
      cwd,
      undefined,
      options
    )) {
      if (chunk.type === 'assistant') text += blockSeam(text, chunk.content) + chunk.content;
      else if (chunk.type === 'result' && chunk.cost !== undefined) costUsd = chunk.cost;
    }
    const suggestion = cleanSuggestion(text);
    getLog().debug({ provider, offered: suggestion !== null, costUsd }, 'suggestion.generated');
    if (suggestion === null) return null;
    return costUsd === undefined ? { text: suggestion } : { text: suggestion, costUsd };
  } catch (error) {
    getLog().warn({ err: error, provider }, 'suggestion.generate_failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
