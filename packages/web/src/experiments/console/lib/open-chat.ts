/**
 * Asking the chat page to open one particular chat.
 *
 * Which chat is open is the chat page's own state, not part of its URL, so a
 * caller elsewhere — the ⌘K palette — hands the id over as navigation state.
 * Every navigation carries a fresh location key, so asking again for a chat in
 * the project already on screen still lands.
 */
export interface OpenChatRequest {
  /** Platform conversation id, the one the rail keys its rows by. */
  openChat: string;
  /** The chat is done, so the rail has to show the done scope to list it. */
  done: boolean;
}

/** The request carried by `state`, or null when the navigation carried none. */
export function readOpenChatRequest(state: unknown): OpenChatRequest | null {
  if (typeof state !== 'object' || state === null) return null;
  const { openChat, done } = state as { openChat?: unknown; done?: unknown };
  if (typeof openChat !== 'string' || openChat === '') return null;
  return { openChat, done: done === true };
}
