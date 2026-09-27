import type { components } from '@/lib/api.generated';
import { requestJson, HttpError } from '../lib/http';
import {
  toConversationSummary,
  type ConversationColor,
  type ConversationSummary,
} from '../primitives/conversation';

/**
 * Conversation verbs for the project-scoped agent chat.
 *
 * This is the second place (after startRun.ts) where the legacy "conversation"
 * concept lives in the console. A chat makes the conversation a first-class
 * entity, so these verbs are the sanctioned home for create / list / send.
 *
 *   - createConversation: POST /api/conversations. When `message` is supplied
 *     the backend dispatches it to the orchestrator atomically and the response
 *     also carries dispatch fields (ignored here). Sends multipart when files
 *     are attached, so the first message of a new chat can carry them.
 *     `conversationId` is the platform id used by every other conversation route.
 *   - renameConversation: PATCH /api/conversations/:id — sets the title,
 *     replacing the server's auto-generated one.
 *   - setConversationColor: PATCH /api/conversations/:id — sets or clears the
 *     color label. An explicit null clears it; omitting it leaves it alone.
 *   - listConversations:  GET /api/conversations?codebaseId=<id>&mine=true
 *     (JSON array). `mine=true` is non-enforcing: it narrows to the signed-in
 *     user's conversations when an identity resolves (Better Auth cookie or
 *     X-Archon-User), so each user gets their own per-project chat on
 *     multi-user installs; with no identity (solo installs) nothing narrows.
 *   - sendMessage:        POST /api/conversations/:id/message. JSON, or
 *     multipart when files are attached (mirrors startRun's multipart path).
 */

/**
 * POST a FormData body and decode the JSON reply.
 *
 * Deliberately not `requestJson`: the Content-Type header must be left unset so
 * the browser can add the multipart boundary. Mirrors requestJson's error
 * decoding so both paths raise the same HttpError.
 */
async function postMultipart<T>(url: string, form: FormData): Promise<T> {
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: { error?: string } = {};
    try {
      parsed = JSON.parse(text) as { error?: string };
    } catch {
      /* not JSON */
    }
    const raw = parsed.error ?? (text.length > 0 ? text : `HTTP ${res.status.toString()}`);
    const msg = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
    const path = new URL(url, window.location.origin).pathname;
    throw new HttpError(res.status, path, msg);
  }
  return (await res.json()) as T;
}

interface CreateConversationResponse {
  conversationId: string;
  id: string;
}

export async function createConversation(
  projectId: string,
  message?: string,
  files?: File[]
): Promise<CreateConversationResponse> {
  if (message !== undefined && files !== undefined && files.length > 0) {
    const form = new FormData();
    form.append('codebaseId', projectId);
    form.append('message', message);
    for (const file of files) {
      form.append('files', file, file.name);
    }
    return postMultipart<CreateConversationResponse>('/api/conversations', form);
  }
  return requestJson<CreateConversationResponse>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify(
      message !== undefined ? { codebaseId: projectId, message } : { codebaseId: projectId }
    ),
  });
}

/**
 * A project's chats, and how many exist in each scope.
 *
 * `counts` is not `chats.length`: the route caps what it returns and finished
 * chats accumulate without bound, so the counts are the difference between a
 * list that is complete and one that merely looks it. They also carry the
 * scopes this list is not showing, which is how the rail labels a tab you
 * would otherwise have to click to learn anything about.
 */
export interface ConversationList {
  chats: ConversationSummary[];
  counts: { open: number; done: number; all: number };
  /** Chats in the requested scope, including any the route did not send. */
  total: number;
  /** The route had more chats in this scope than it sent. */
  truncated: boolean;
}

/** No project selected: nothing listed, and nothing withheld either. */
export const EMPTY_CONVERSATION_LIST: ConversationList = {
  chats: [],
  counts: { open: 0, done: 0, all: 0 },
  total: 0,
  truncated: false,
};

/**
 * A project's chats, filtered by where they are in their lifecycle.
 *
 * `archived=active` is not a choice the console offers any more — it never
 * lists a soft-deleted row. Deleting a chat is an API operation with no
 * control in the rail, so a deleted chat is gone from the console rather than
 * sitting in a scope nothing navigates to.
 */
export async function listConversations(
  projectId: string,
  state: 'open' | 'done' | 'all' = 'open'
): Promise<ConversationList> {
  const raw = await requestJson<{
    conversations: Parameters<typeof toConversationSummary>[0][];
    counts: { open: number; done: number; all: number };
  }>(
    `/api/conversations?codebaseId=${encodeURIComponent(projectId)}&mine=true&archived=active&state=${state}`
  );
  const chats = raw.conversations.map(toConversationSummary);
  // The count for the scope that was asked for. The server ignores `state`
  // when counting, so this picks the one the rows were drawn from rather than
  // carrying a second number that has to agree with it.
  const total = raw.counts[state];
  return { chats, counts: raw.counts, total, truncated: total > chats.length };
}

/**
 * Arrange a run of chats: `ids` is the order they should appear in, top first.
 *
 * Only the chats the rail is showing are named. The server rearranges them
 * within the positions they already hold, so chats in another archive scope —
 * which this rail cannot see and must not speak for — keep their places.
 */
export async function setConversationOrder(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await requestJson<{ success: boolean }>('/api/conversations/order', {
    method: 'PUT',
    body: JSON.stringify({ ids }),
  });
}

/**
 * Mark a chat's unit of work finished, or reopen it.
 *
 * The console's whole chat lifecycle: a chat is open or done, and this is the
 * only thing that moves it either way. Marking it done takes it out of the
 * default list, which is the job archiving used to do under a second name.
 */
export async function setConversationCompleted(
  conversationPlatformId: string,
  completed: boolean
): Promise<void> {
  await requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}`,
    { method: 'PATCH', body: JSON.stringify({ completed }) }
  );
}

/**
 * Declare, or withdraw, that this chat's work is finished.
 *
 * The AGENT's claim, not the human's answer — `setConversationCompleted` above
 * is that, and the two are kept apart so an agent can never close its own work.
 * A chat carrying this reads as "Ready to close" in the rail, which is the
 * state between "nothing is running" and "this is finished".
 *
 * There is no matching call to turn it off, on purpose. The server clears it
 * when a human marks the chat done or sends another message, so the only thing
 * that withdraws a claim is evidence against it. The derived version of this
 * signal — "the newest message is the agent's" — was built and removed twice
 * for being unable to turn off at all; see `primitives/chat-status.ts`. Passing
 * `false` is still accepted, for an agent that decides mid-turn it was wrong.
 */
export async function setConversationReady(
  conversationPlatformId: string,
  ready: boolean
): Promise<void> {
  await requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}`,
    { method: 'PATCH', body: JSON.stringify({ ready }) }
  );
}

/** Whether a conversation is executing a turn right now. */
export type ConversationLock = components['schemas']['ConversationLockResponse'];

/**
 * Ask whether the server is executing a turn for this chat right now.
 *
 * The recovery half of the composer's disabled state. While the event stream
 * is up the `conversation_lock` events carry this and no request is made; a
 * reconnect is the only thing that asks, because the events emitted during the
 * gap are gone and EventSource replays nothing. Deliberately not polled — the
 * question only has a new answer when something announced one, and the
 * announcement is what a gap loses.
 */
export async function getConversationLock(
  conversationPlatformId: string
): Promise<ConversationLock> {
  return requestJson<ConversationLock>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}/lock`
  );
}

/** What a stop request found: stopped, still stopping, or nothing running. */
export type InterruptResult = components['schemas']['ConversationInterruptResponse'];

/**
 * Stop the chat's running turn.
 *
 * The server aborts the turn through its provider and answers once it has
 * ended, or says it is still stopping when the provider is slower than the
 * server will wait. Either way the composer's lock is released by the server's
 * own lock event, not by this reply.
 */
export async function interruptConversation(
  conversationPlatformId: string
): Promise<InterruptResult> {
  return requestJson<InterruptResult>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}/interrupt`,
    { method: 'POST' }
  );
}

/** A message sent while the agent was working, waiting its turn. */
export type QueuedMessage = components['schemas']['QueuedMessage'];
export type ConversationQueue = components['schemas']['ConversationQueueResponse'];

/**
 * The messages queued behind the running turn, oldest first. Held by the
 * server, so a reload or a second tab sees the same list; the stream's
 * `conversation_queue` event says when to ask again.
 */
export async function getConversationQueue(
  conversationPlatformId: string
): Promise<ConversationQueue> {
  return requestJson<ConversationQueue>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}/queue`
  );
}

export type WithdrawResult = components['schemas']['WithdrawQueuedResponse'];

/**
 * Take a queued message back. The server decides the race with delivery:
 * `withdrawn` carries the text that was queued, `not-queued` means the agent
 * already has it.
 */
export async function withdrawQueuedMessage(
  conversationPlatformId: string,
  queuedId: string
): Promise<WithdrawResult> {
  return requestJson<WithdrawResult>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}/queue/${encodeURIComponent(queuedId)}`,
    { method: 'DELETE' }
  );
}

/**
 * Record that the reader has reached the bottom of this chat.
 *
 * The only thing that clears the rail's unread mark. A POST with no body: the
 * client is not choosing a value, it is reporting an event, and the server owns
 * the timestamp — two clocks deciding what "now" means is how a mark ends up
 * clearing itself a second before the message that set it.
 */
export async function markConversationRead(conversationPlatformId: string): Promise<void> {
  await requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}/read`,
    { method: 'POST' }
  );
}

/** How the server took a message: started now, or queued behind a running turn. */
export type DispatchResult = components['schemas']['DispatchResponse'];

export async function sendMessage(
  conversationPlatformId: string,
  message: string,
  files?: File[]
): Promise<DispatchResult> {
  const url = `/api/conversations/${encodeURIComponent(conversationPlatformId)}/message`;

  if (files === undefined || files.length === 0) {
    return requestJson<DispatchResult>(url, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  const form = new FormData();
  form.append('message', message);
  for (const file of files) {
    form.append('files', file, file.name);
  }
  return postMultipart<DispatchResult>(url, form);
}

/**
 * Rename a conversation. The server auto-titles from the first message; this
 * overwrites that with the user's own wording and it sticks.
 */
export async function renameConversation(
  conversationPlatformId: string,
  title: string
): Promise<void> {
  await requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}`,
    { method: 'PATCH', body: JSON.stringify({ title }) }
  );
}

/**
 * Set or clear a conversation's color label. `null` clears it — the server
 * distinguishes an explicit null from an omitted field.
 */
export async function setConversationColor(
  conversationPlatformId: string,
  color: ConversationColor | null
): Promise<void> {
  await requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}`,
    { method: 'PATCH', body: JSON.stringify({ color }) }
  );
}
