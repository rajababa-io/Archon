/**
 * The every-project chat list, grouped by what each chat wants from you.
 *
 * A project's own rail keeps its hand-arranged order: one project's chats are
 * few, and where you put them is the point. Across every project there is no
 * arrangement to honour — a drag would move rows between projects' positions —
 * so the list is ordered by the one question that spans projects: which of
 * these needs me first.
 */
import type { ChatStatus } from './chat-status';
import type { ConversationSummary } from './conversation';

export type ChatGroupKey = 'needs-you' | 'working' | 'ready' | 'idle' | 'closed';

/**
 * Which group each status belongs to. A Record over the status union, so a new
 * status is a type error here until it is given a place.
 *
 * Unread is not a status and has no group: an unread chat sits wherever whose
 * move it is puts it, with its title in bold (#5). `waiting` (on CI) and `running` (a workflow the chat
 * started) are the agent's move, not yours, so they sit with `working`.
 */
const GROUP_OF: Readonly<Record<ChatStatus, ChatGroupKey>> = {
  awaiting: 'needs-you',
  working: 'working',
  waiting: 'working',
  running: 'working',
  ready: 'ready',
  idle: 'idle',
  done: 'closed',
};

/** Display order, most urgent first, with each group's heading. */
export const CHAT_GROUPS: readonly { key: ChatGroupKey; label: string }[] = [
  { key: 'needs-you', label: 'Needs you' },
  { key: 'working', label: 'Working' },
  { key: 'ready', label: 'Ready to close' },
  { key: 'idle', label: 'Idle' },
  { key: 'closed', label: 'Closed' },
];

export interface ChatGroup {
  key: ChatGroupKey;
  label: string;
  chats: ConversationSummary[];
}

function activity(iso: string | null): number {
  const t = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Chats grouped by status, most recent first inside each group. Empty groups
 * are left out, so a heading always has rows under it.
 */
export function groupChatsByStatus(
  chats: readonly ConversationSummary[],
  statusOf: (chatId: string) => ChatStatus
): ChatGroup[] {
  const buckets = new Map<ChatGroupKey, ConversationSummary[]>();
  for (const chat of chats) {
    const key = GROUP_OF[statusOf(chat.id)];
    const rows = buckets.get(key) ?? [];
    rows.push(chat);
    buckets.set(key, rows);
  }
  const groups: ChatGroup[] = [];
  for (const { key, label } of CHAT_GROUPS) {
    const rows = buckets.get(key);
    if (rows === undefined) continue;
    rows.sort((a, b) => activity(b.lastActivityAt) - activity(a.lastActivityAt));
    groups.push({ key, label, chats: rows });
  }
  return groups;
}
