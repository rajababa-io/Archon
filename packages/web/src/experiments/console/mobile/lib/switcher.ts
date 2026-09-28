/**
 * The switcher's list: every open chat, grouped by project, the chats that
 * need you first. Pure, so the order is tested rather than eyeballed.
 */
import type { ChatStatus } from '../../primitives/chat-status';
import type { FoundChat } from '../../skills/conversations';

/**
 * Most urgent first. A Record over the status union, so a new status is a type
 * error here until it is given a place.
 *
 * `awaiting` and `unread` lead because they are what the needs-you badge
 * counts; `working` next, because it is the thing most likely to change while
 * you look.
 */
const URGENCY: Readonly<Record<ChatStatus, number>> = {
  awaiting: 0,
  unread: 1,
  working: 2,
  ready: 3,
  waiting: 4,
  running: 5,
  idle: 6,
  done: 7,
};

export interface SwitcherRow {
  chat: FoundChat['chat'];
  status: ChatStatus;
}

export interface SwitcherGroup {
  projectId: string;
  rows: SwitcherRow[];
}

function activity(iso: string | null): number {
  const t = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function byUrgency(a: SwitcherRow, b: SwitcherRow): number {
  return (
    URGENCY[a.status] - URGENCY[b.status] ||
    activity(b.chat.lastActivityAt) - activity(a.chat.lastActivityAt)
  );
}

/**
 * Chats a human has closed are left out: the switcher is for moving between
 * work in flight, and closed chats accumulate without bound. Groups are
 * ordered by their most urgent chat, then by name, so a project with a
 * question waiting is at the top.
 */
export function switcherGroups(
  chats: readonly FoundChat[],
  statuses: ReadonlyMap<string, ChatStatus>,
  projectLabel: (projectId: string) => string
): SwitcherGroup[] {
  const byProject = new Map<string, SwitcherRow[]>();
  for (const { chat, projectId } of chats) {
    if (chat.completed) continue;
    const rows = byProject.get(projectId) ?? [];
    rows.push({ chat, status: statuses.get(chat.id) ?? 'idle' });
    byProject.set(projectId, rows);
  }
  const groups = [...byProject].map(([projectId, rows]) => ({
    projectId,
    rows: rows.sort(byUrgency),
  }));
  return groups.sort((a, b) => {
    const first = (g: SwitcherGroup): SwitcherRow | undefined => g.rows[0];
    const ra = first(a);
    const rb = first(b);
    const lead = ra !== undefined && rb !== undefined ? URGENCY[ra.status] - URGENCY[rb.status] : 0;
    return lead || projectLabel(a.projectId).localeCompare(projectLabel(b.projectId));
  });
}

/** One project's open chats, in the switcher's order. */
export function projectChatRows(
  chats: readonly FoundChat[],
  statuses: ReadonlyMap<string, ChatStatus>,
  projectId: string
): SwitcherRow[] {
  return chats
    .filter(c => c.projectId === projectId && !c.chat.completed)
    .map(({ chat }) => ({ chat, status: statuses.get(chat.id) ?? 'idle' }))
    .sort(byUrgency);
}
