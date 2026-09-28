import { useCallback, useEffect, useRef } from 'react';
import { usePageVisible } from '../lib/use-page-visible';
import * as skill from '../skills';

interface ReadMarkerArgs {
  /** Platform id of the chat on screen, or null when none is. */
  conversationId: string | null;
  /** That chat's last-activity stamp, from the conversation row. */
  lastActivityAt: string | null;
  /** A turn is in flight for it. */
  working: boolean;
  /**
   * The unread set from the shared status sets. The set, not a boolean for
   * this chat: its identity changes on every list refresh, which is what
   * retries a write that failed.
   */
  unread: ReadonlySet<string>;
  /** The read mark landed; the caller refreshes the lists that show it. */
  onMarked: () => void;
}

export interface ReadMarker {
  /**
   * "Mark unread" on the chat being read: hold its current (chat, activity)
   * pair, so the mark survives until the chat is opened again or says
   * something new, instead of being undone the moment the list refreshes.
   */
  holdUnread: (conversationId: string, lastActivityAt: string | null) => void;
}

/**
 * Clear the unread mark when the chat is opened (#228). One rule for every
 * chat screen, so the desktop page and the mobile shell clear it identically.
 *
 * This used to wait for the reader to reach the bottom of the stream, on the
 * theory that opening is not reading. In use it left chats amber after being
 * clicked, which made the rail's to-do list lie; opening is the signal.
 *
 * `working` gates it because a turn still streaming has not been read yet, by
 * anyone: its last line does not exist. That also matches the rail, where
 * working outranks unread.
 *
 * Page visibility gates it too: a hidden tab has not been read, even with the
 * chat open at its bottom. Marking it anyway would clear the unread mark the
 * tab badge counts, so a turn that ends while you are away would leave no
 * trace for you to come back to. Returning to the tab re-runs this.
 *
 * The ref keys on the ACTIVITY TIMESTAMP, not just the chat, and is what
 * stops this being a write per render. `unread` is derived from a polled
 * feed, so it stays true for a beat after the POST lands; without the key
 * every one of those renders would fire another. A new reply moves the
 * timestamp, which is exactly when a second write is wanted. The same key is
 * how "Mark unread" on the open chat holds; switching chats forgets it, so
 * opening that chat again reads it.
 */
export function useReadMarker({
  conversationId,
  lastActivityAt,
  working,
  unread,
  onMarked,
}: ReadMarkerArgs): ReadMarker {
  const markedRef = useRef<string | null>(null);
  const onMarkedRef = useRef(onMarked);
  onMarkedRef.current = onMarked;
  const visible = usePageVisible();

  useEffect(() => {
    markedRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    if (conversationId === null || lastActivityAt === null) return;
    if (working || !visible || !unread.has(conversationId)) return;
    const key = `${conversationId}|${lastActivityAt}`;
    if (markedRef.current === key) return;
    markedRef.current = key;
    void skill
      .markConversationRead(conversationId)
      .then(() => {
        onMarkedRef.current();
      })
      .catch(() => {
        // Let the next list refresh try again. Nothing is shown: an
        // unread mark that failed to clear is a stale dot, not a lost message,
        // and an error banner over a cosmetic write would be the louder bug.
        markedRef.current = null;
      });
  }, [conversationId, lastActivityAt, working, unread, visible]);

  const holdUnread = useCallback((id: string, at: string | null): void => {
    markedRef.current = `${id}|${at}`;
  }, []);

  return { holdUnread };
}
