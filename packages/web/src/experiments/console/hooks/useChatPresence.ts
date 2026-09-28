import { useEffect } from 'react';
import * as skill from '../skills';

/**
 * One id per page load: two tabs on the same chat are two viewers. Not
 * `crypto.randomUUID`, which a console served over plain http on a LAN
 * address does not have.
 */
const CLIENT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Well inside the server's 45 s expiry, so one lost beat does not lapse the report. */
export const PRESENCE_HEARTBEAT_MS = 20_000;

/**
 * Tell the server which chat this page is showing, so it does not push a
 * notification about a chat that is already in front of you — on this device
 * or any other. Reports the chat while the page is visible, on a heartbeat,
 * and "nothing" the moment it is hidden, switched away from, or closed.
 *
 * A failed report is logged and otherwise ignored: the worst it causes is one
 * notification about a chat you were looking at.
 */
export function useChatPresence(conversationId: string | null): void {
  useEffect(() => {
    if (conversationId === null || conversationId === '') return;
    const report = (showing: string | null): void => {
      skill.reportPresence(CLIENT_ID, showing).catch((e: unknown) => {
        console.warn('[push] presence report failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    };
    const beat = (): void => {
      report(document.visibilityState === 'visible' ? conversationId : null);
    };
    beat();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') beat();
    }, PRESENCE_HEARTBEAT_MS);
    document.addEventListener('visibilitychange', beat);
    return (): void => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
      report(null);
    };
  }, [conversationId]);
}
