/**
 * What the browser tab says about the chats, and when a chat is worth a
 * notification. Pure: `lib/use-tab-signal` owns the document and the
 * Notification API; this owns the decisions, so they can be tested.
 *
 * Both read `chatStatus` and nothing else. The rail already decides what each
 * chat is; a tab that worked it out again from messages or timers would be a
 * second vocabulary that could disagree with the dot beside the chat.
 */
import { chatStatus } from './chat-status';
import type { ChatStatus, ChatStatusSets } from './chat-status';

/**
 * Every listed chat's status, from the same sets the rail and the status bar
 * read — `chatStatusSets` builds them, `chatStatus` ranks them.
 */
export function chatStatuses(
  conversations: readonly { id: string }[],
  sets: ChatStatusSets
): Map<string, ChatStatus> {
  const out = new Map<string, ChatStatus>();
  for (const c of conversations) out.set(c.id, chatStatus(c.id, sets));
  return out;
}

/** One chat that needs you. */
export interface ChatNotification {
  id: string;
  projectId: string;
  title: string | null;
  lastActivityAt: string | null;
  /** Closed. A run paused on a gate can still ask from a closed chat. */
  completed: boolean;
}

/**
 * The chats that need you: status `awaiting`, the rail's "Needs you". This
 * list IS the notification count — the favicon badge, the phone's badge and
 * its Home Screen icon all take `.length` of it, so every surface shows the
 * same number.
 *
 * Unread is deliberately not counted (#333). It once was (#289), and a chat
 * that had only finished a turn then read as `1` beside one that was asking —
 * the badge could no longer say whether you were needed. Unread stays the bold
 * title in the rail. Working is not counted either: from another tab the only
 * question worth answering is whether something needs you.
 *
 * Newest activity first.
 */
export function chatNotifications(
  found: readonly {
    chat: {
      id: string;
      title: string | null;
      lastActivityAt: string | null;
      completed: boolean;
    };
    projectId: string;
  }[],
  statuses: ReadonlyMap<string, ChatStatus>
): ChatNotification[] {
  const out: ChatNotification[] = [];
  for (const { chat, projectId } of found) {
    if (statuses.get(chat.id) !== 'awaiting') continue;
    out.push({
      id: chat.id,
      projectId,
      title: chat.title,
      lastActivityAt: chat.lastActivityAt,
      completed: chat.completed,
    });
  }
  const at = (n: ChatNotification): number => {
    const ms = n.lastActivityAt === null ? Number.NaN : Date.parse(n.lastActivityAt);
    return Number.isNaN(ms) ? 0 : ms;
  };
  return out.sort((a, b) => at(b) - at(a));
}

/**
 * The favicon badge's text, Gmail's way: the number up to 99, `99+` past it,
 * nothing at zero. Three characters is the most a tab icon can hold legibly.
 */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
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
