/**
 * Keeps the browser tab telling the truth about the chats while you are
 * somewhere else: the favicon's count badge always, and a notification when
 * you opted in.
 *
 * The title is left alone. It carried the same count as `(N)` until the badge
 * was readable at tab size; two copies of one number only crowded the name.
 *
 * Every project's chats, not the ones on screen. The tab stands for the whole
 * install, so a chat waiting in another project has to raise it — a count that
 * followed the open project read "nothing" while another project asked (#269).
 * The mobile shell's badge reads the same list, through `useMobileChats`.
 *
 * Mounted once, at the console root, so the badge is drawn on every page.
 *
 * Decisions live in `primitives/tab-signal`; this is the wiring to the document
 * and the Notification API.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { ALL_SCOPE, K } from '../store/keys';
import { awaitingInputIds, chatStatusSets, runningRunIds } from '../primitives/chat-status';
import type { ChatStatus } from '../primitives/chat-status';
import type { Run } from '../primitives/run';
import {
  alertText,
  badgeText,
  chatAlerts,
  chatStatuses,
  wantingCount,
} from '../primitives/tab-signal';
import { useFaviconBadge } from './favicon-badge';
import { useLiveChats } from './live-chats';
import { notifyState } from './notify';
import type { OpenChatRequest } from './open-chat';

export function useTabSignal(): void {
  const { data: all } = useEntity(K.allConversations, () => skill.listAllConversations());
  const { data: runFeed } = useEntity<{ runs: Run[] }>(K.runs(ALL_SCOPE), () =>
    skill.listRuns({ limit: skill.RUN_LIMIT })
  );
  const live = useLiveChats();

  const chats = useMemo(() => (all?.chats ?? []).map(f => f.chat), [all]);
  const statuses = useMemo<ReadonlyMap<string, ChatStatus>>(
    () =>
      chatStatuses(
        chats,
        chatStatusSets(chats, {
          working: live.ids,
          runAwaiting: awaitingInputIds(runFeed?.runs ?? []),
          running: runningRunIds(runFeed?.runs ?? []),
          waiting: live.ciWaiting,
        })
      ),
    [chats, live.ids, live.ciWaiting, runFeed?.runs]
  );

  useFaviconBadge(badgeText(wantingCount(statuses)));

  const foundRef = useRef(all?.chats ?? []);
  foundRef.current = all?.chats ?? [];
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

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
      const found = foundRef.current.find(f => f.chat.id === id);
      if (found === undefined) continue;
      const { title, body } = alertText(kind, found.chat.title);
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
      // The chat's own project, which need not be the one on screen. The chat
      // page reads this request the way it reads one from the ⌘K palette.
      const request: OpenChatRequest = { openChat: id, done: found.chat.completed };
      n.onclick = (): void => {
        window.focus();
        navigateRef.current(`/console/p/${found.projectId}/chat`, { state: request });
        n.close();
      };
    }
  }, [statuses]);
}
