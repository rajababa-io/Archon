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
 * `awaiting` leads because it is your move; `working` next, because it is the
 * thing most likely to change while you look. Unread is not a status (#5): it
 * breaks ties inside one, so an unread chat leads its peers.
 */
const URGENCY: Readonly<Record<ChatStatus, number>> = {
  awaiting: 0,
  working: 1,
  ready: 2,
  waiting: 3,
  running: 4,
  idle: 5,
  done: 6,
};

export interface SwitcherRow {
  chat: FoundChat['chat'];
  status: ChatStatus;
  /** Moved since you last read it — drawn as a bold title. */
  unread: boolean;
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
    Number(b.unread) - Number(a.unread) ||
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
  unread: ReadonlySet<string>,
  projectLabel: (projectId: string) => string
): SwitcherGroup[] {
  const byProject = new Map<string, SwitcherRow[]>();
  for (const { chat, projectId } of chats) {
    if (chat.completed) continue;
    const rows = byProject.get(projectId) ?? [];
    rows.push({ chat, status: statuses.get(chat.id) ?? 'idle', unread: unread.has(chat.id) });
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
    const lead =
      ra !== undefined && rb !== undefined
        ? URGENCY[ra.status] - URGENCY[rb.status] || Number(rb.unread) - Number(ra.unread)
        : 0;
    return lead || projectLabel(a.projectId).localeCompare(projectLabel(b.projectId));
  });
}

/** One project's open chats, in the switcher's order. */
export function projectChatRows(
  chats: readonly FoundChat[],
  statuses: ReadonlyMap<string, ChatStatus>,
  unread: ReadonlySet<string>,
  projectId: string
): SwitcherRow[] {
  return chats
    .filter(c => c.projectId === projectId && !c.chat.completed)
    .map(({ chat }) => ({
      chat,
      status: statuses.get(chat.id) ?? 'idle',
      unread: unread.has(chat.id),
    }))
    .sort(byUrgency);
}

export interface ProjectRow {
  projectId: string;
  /** Open chats in it — zero is a row too, which is the point of the list (#292). */
  open: number;
}

/**
 * Every registered project, by name, each with its count of open chats. Built
 * from the project list, not from the chats, so a project nobody is chatting in
 * still has a way in from the phone.
 */
export function projectRows(
  projectIds: readonly string[],
  chats: readonly FoundChat[],
  projectLabel: (projectId: string) => string
): ProjectRow[] {
  const open = new Map<string, number>();
  for (const { chat, projectId } of chats) {
    if (!chat.completed) open.set(projectId, (open.get(projectId) ?? 0) + 1);
  }
  return projectIds
    .map(projectId => ({ projectId, open: open.get(projectId) ?? 0 }))
    .sort((a, b) => projectLabel(a.projectId).localeCompare(projectLabel(b.projectId)));
}
