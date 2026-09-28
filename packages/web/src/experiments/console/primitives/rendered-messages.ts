/**
 * The transcript a chat screen draws: the stored rows, then the reader's own
 * unconfirmed message, then any streamed reply the database has not caught up
 * with. Shared by the desktop chat page and the mobile chat screen, so both
 * show a turn in flight the same way.
 */
import type { Message } from './message';
import { pendingSegments, type LiveSegment } from './live-text';

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
 * slices by how many rows this turn already has, measured against the STORED
 * rows alone — the echo is not one — so nothing is compared by content and
 * nothing needs de-duplicating.
 */
export function renderedMessages(
  stored: readonly Message[],
  pendingUser: PendingUser | null,
  live: LiveSegment[],
  now: string
): Message[] {
  const out: Message[] = [...stored];
  if (pendingUser !== null) {
    out.push(
      synthetic('pending-user', 'user', pendingUser.content, now, { files: pendingUser.files })
    );
  }
  pendingSegments(live, [...stored]).forEach((seg, i) => {
    out.push(
      synthetic(`live-${String(i)}`, 'assistant', seg.content, now, {
        category: seg.category,
        thinking: seg.thinking ?? null,
      })
    );
  });
  return out;
}
