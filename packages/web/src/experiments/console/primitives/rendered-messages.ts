/**
 * The transcript a chat screen draws: the stored rows, then the reader's own
 * unconfirmed message, then any streamed reply the database has not caught up
 * with. Shared by the desktop chat page and the mobile chat screen, so both
 * show a turn in flight the same way.
 */
import type { Message } from './message';
import { pendingSegments, type LivePreview } from './live-text';

/** Id prefix of a streamed reply the database has not stored yet. */
const LIVE_PREFIX = 'live-';

/**
 * Whether this message is a streamed preview rather than a stored row.
 *
 * Owned here because this module mints the preview ids, so the prefix is
 * stated once. The chat reads it to keep a reply's thinking open only
 * while that reply is still arriving.
 */
export function isLivePreview(message: Pick<Message, 'id'>): boolean {
  return message.id.startsWith(LIVE_PREFIX);
}

/** A message this tab sent that the server has not stored yet. */
export interface PendingUser {
  content: string;
  files: Message['files'];
}

function synthetic(
  id: string,
  role: Message['role'],
  content: string,
  timestamp: string,
  rest: Partial<Pick<Message, 'files' | 'category' | 'thinking'>> = {}
): Message {
  return {
    id,
    role,
    content,
    timestamp,
    toolCalls: [],
    files: rest.files ?? [],
    midTurn: false,
    error: null,
    category: rest.category ?? null,
    dispatch: null,
    workflowResult: null,
    usage: null,
    thinking: rest.thinking ?? null,
  };
}

/**
 * Each preview disappears the moment its real row lands: `pendingSegments`
 * slices by how many rows this turn has stored since the tab joined it,
 * measured against the STORED rows alone — the echo is not one — so nothing is
 * compared by content and nothing needs de-duplicating.
 */
export function renderedMessages(
  stored: readonly Message[],
  pendingUser: PendingUser | null,
  live: LivePreview,
  now: string
): Message[] {
  const out: Message[] = [...stored];
  if (pendingUser !== null) {
    out.push(
      synthetic('pending-user', 'user', pendingUser.content, now, { files: pendingUser.files })
    );
  }
  pendingSegments(live.segments, stored, live.joined).forEach((seg, i) => {
    out.push(
      synthetic(`${LIVE_PREFIX}${String(i)}`, 'assistant', seg.content, now, {
        category: seg.category,
        thinking: seg.thinking ?? null,
      })
    );
  });
  return out;
}

/**
 * The same transcript with thinking removed — the phone shows replies only
 * (#307). A small screen has no room for a second, quieter stream, and a
 * message that carried only thinking then has nothing left to draw, which
 * `ChatStream` already drops.
 */
export function withoutThinking(messages: Message[]): Message[] {
  return messages.map(m => (m.thinking === null ? m : { ...m, thinking: null }));
}
