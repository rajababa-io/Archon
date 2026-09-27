/**
 * What the browser tab says about the chats, and when a chat is worth a
 * notification. Pure: `lib/use-tab-signal` owns the document and the
 * Notification API; this owns the decisions, so they can be tested.
 *
 * Both read `chatStatus` and nothing else. The rail already decides what each
 * chat is; a tab that worked it out again from messages or timers would be a
 * second vocabulary that could disagree with the dot beside the chat.
 */
import { askAwaitingIds, chatStatus, completedIds, readyIds, unreadIds } from './chat-status';
import type { ChatStatus } from './chat-status';

/**
 * Every listed chat's status, by the same sets and the same precedence the rail
 * draws. A run paused on an approval and an unanswered ask block both count as
 * awaiting, merged exactly as the rail merges them.
 */
export function chatStatuses(
  conversations: readonly {
    id: string;
    completed: boolean;
    ready: boolean;
    askCandidate: string | null;
    lastActivityAt: string | null;
    lastReadAt: string | null;
  }[],
  working: ReadonlySet<string>,
  runAwaiting: ReadonlySet<string>,
  ciWaiting: ReadonlySet<string>
): Map<string, ChatStatus> {
  const awaiting = askAwaitingIds(conversations);
  for (const id of runAwaiting) awaiting.add(id);
  const sets = {
    working,
    awaiting,
    unread: unreadIds(conversations),
    done: completedIds(conversations),
    ready: readyIds(conversations),
    waiting: ciWaiting,
  };
  const out = new Map<string, ChatStatus>();
  for (const c of conversations) out.set(c.id, chatStatus(c.id, sets));
  return out;
}

/**
 * How many chats want you: the rail's amber — awaiting and unread.
 *
 * Those are the two states that ask a person to come and look. A turn that
 * ends while you are away leaves its chat unread, so this rising is how "done"
 * reaches a tab you are not looking at. Ready and done are green: nothing to
 * come back for.
 *
 * Working is deliberately not counted, and nothing in the tab says a chat is
 * merely working: from another tab the only question worth answering is
 * whether something needs you.
 */
export function wantingCount(statuses: ReadonlyMap<string, ChatStatus>): number {
  let n = 0;
  for (const s of statuses.values()) if (s === 'awaiting' || s === 'unread') n += 1;
  return n;
}

/** The tab title: `(N) base`, or the bare base when nothing wants you. */
export function tabTitle(base: string, count: number): string {
  return count > 0 ? `(${String(count)}) ${base}` : base;
}

/**
 * The favicon badge's text, Gmail's way: the number up to nine, `9+` past it,
 * nothing at zero. A 16px icon has room for two characters and no more.
 */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 9 ? '9+' : String(count);
}

export type ChatAlertKind = 'finished' | 'asking';

export interface ChatAlert {
  id: string;
  kind: ChatAlertKind;
}

/**
 * Which chats just crossed into something a person should hear about.
 *
 *   asking    entered `awaiting` — an ask block or a gate is waiting on you
 *   finished  left `working` for anything but `awaiting`
 *
 * A turn that ends on a question is one alert, `asking`, not two: the
 * question is the part that needs you.
 *
 * A chat with no previous status is skipped. That is the first sight of the
 * list, or a chat that has just appeared in it, and neither is a change — an
 * alert per chat on page load would be a burst of noise about nothing.
 */
export function chatAlerts(
  prev: ReadonlyMap<string, ChatStatus>,
  next: ReadonlyMap<string, ChatStatus>
): ChatAlert[] {
  const out: ChatAlert[] = [];
  for (const [id, now] of next) {
    const was = prev.get(id);
    if (was === undefined || was === now) continue;
    if (now === 'awaiting') out.push({ id, kind: 'asking' });
    else if (was === 'working') out.push({ id, kind: 'finished' });
  }
  return out;
}

/**
 * The notification's words. Chat names only, never message text: a
 * notification is drawn by the operating system, on a lock screen or a shared
 * display, outside anything the console controls.
 */
export function alertText(
  kind: ChatAlertKind,
  chatTitle: string | null
): { title: string; body: string } {
  const name = chatTitle !== null && chatTitle.trim() !== '' ? chatTitle : 'Untitled chat';
  return kind === 'asking'
    ? { title: 'Waiting on you', body: name }
    : { title: 'Chat finished', body: name };
}
