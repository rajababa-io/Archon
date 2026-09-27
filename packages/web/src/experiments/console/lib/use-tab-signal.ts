/**
 * Keeps the browser tab telling the truth about the chats while you are
 * somewhere else: the favicon's count badge always, and a notification when
 * you opted in.
 *
 * The title is left alone. It carried the same count as `(N)` until the badge
 * was readable at tab size; two copies of one number only crowded the name.
 *
 * Decisions live in `primitives/tab-signal`; this is the wiring to the document
 * and the Notification API.
 */
import { useEffect, useRef } from 'react';
import type { ChatStatus } from '../primitives/chat-status';
import { alertText, badgeText, chatAlerts, wantingCount } from '../primitives/tab-signal';
import { useFaviconBadge } from './favicon-badge';
import { notifyState } from './notify';

export function useTabSignal(
  statuses: ReadonlyMap<string, ChatStatus>,
  titles: ReadonlyMap<string, string | null>,
  onOpen: (conversationId: string) => void
): void {
  useFaviconBadge(badgeText(wantingCount(statuses)));

  const titlesRef = useRef(titles);
  titlesRef.current = titles;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  // Compared against the last statuses SEEN, not the last ones alerted on, so a
  // change that happened while the tab was visible is spent and does not fire
  // later when the reader happens to leave.
  const prevRef = useRef<ReadonlyMap<string, ChatStatus>>(new Map());
  useEffect(() => {
    const alerts = chatAlerts(prevRef.current, statuses);
    prevRef.current = statuses;
    // Visible means the reader can already see the rail; a notification then
    // would only repeat it.
    if (alerts.length === 0 || document.visibilityState === 'visible') return;
    if (notifyState() !== 'on') return;
    for (const { id, kind } of alerts) {
      const { title, body } = alertText(kind, titlesRef.current.get(id) ?? null);
      // `tag` per chat: a chat that finishes and then asks replaces its own
      // notification rather than stacking a second one.
      let n: Notification;
      try {
        n = new Notification(title, { body, tag: `archon-chat:${id}` });
      } catch (e: unknown) {
        // Some browsers (Chrome on Android) only allow notifications from a
        // service worker and throw here despite a granted permission. The
        // title has already changed, so the signal is not lost — say why the
        // popup is missing rather than taking the page down with it.
        console.warn('[console] notification could not be shown', e);
        return;
      }
      n.onclick = (): void => {
        window.focus();
        onOpenRef.current(id);
        n.close();
      };
    }
  }, [statuses]);
}
