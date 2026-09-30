/**
 * Every chat the shell can open, across every project, with each one's status
 * — read once and shared by the header badge, the switcher and the chat
 * screen, so none of them can disagree about what a chat is.
 *
 * The statuses come from the console's own `chatStatusSets` and `chatStatus`
 * fed the same three live inputs the desktop rail reads; the only difference
 * is the scope, which is every project rather than one.
 */
import { useCallback, useEffect, useMemo } from 'react';
import * as skill from '../../skills';
import { invalidate, useEntity } from '../../store/cache';
import { ALL_SCOPE, K } from '../../store/keys';
import { useLiveChats } from '../../lib/live-chats';
import { getDisplayName, projectLabel } from '../../lib/display-name';
import {
  awaitingInputIds,
  chatStatusSets,
  runningRunIds,
  type ChatStatus,
  type ChatStatusSets,
} from '../../primitives/chat-status';
import {
  chatNotifications,
  chatStatuses,
  type ChatNotification,
} from '../../primitives/tab-signal';
import type { Project } from '../../primitives/project';
import type { Run } from '../../primitives/run';
import { reachOf, useOnLine, type Reach } from './reach';
import { useSavedChats } from './saved-chats';

/**
 * How often the chat list is re-read while the app is on screen.
 *
 * A backstop, as on the desktop chat page. The dashboard stream narrows
 * `conversation_changed` to one project's list key, which never reaches the
 * every-project list this reads, so a title the agent rewrote or a chat
 * created elsewhere would otherwise wait for the next lock event.
 */
const LIST_POLL_MS = 8000;

/**
 * How long the chat list may go unanswered before Archon counts as out of
 * reach. A dead tailnet link usually hangs rather than refusing, and an
 * unbounded read would leave the shell showing neither chats nor the banner.
 */
const REACH_TIMEOUT_MS = 10_000;

export interface MobileChats {
  /**
   * The server's list — or, while Archon cannot be reached and the list was
   * never read, the chats saved on this phone for reading offline.
   */
  chats: readonly skill.FoundChat[] | undefined;
  error: Error | undefined;
  reach: Reach;
  statusSets: ChatStatusSets;
  statuses: ReadonlyMap<string, ChatStatus>;
  /** Chats that want you, newest first — the list behind the desktop's bell (#289). */
  notifications: readonly ChatNotification[];
  /** `notifications.length` — the same count the desktop tab badge shows. */
  needsYou: number;
  /** What each working chat is running right now, when it is inside a tool. */
  liveTools: ReturnType<typeof useLiveChats>['tools'];
  ciWaitingSince: ReturnType<typeof useLiveChats>['ciWaitingSince'];
  projectLabel: (projectId: string) => string;
}

export function useMobileChats(): MobileChats {
  const { data: all, error } = useEntity(K.allConversations, () =>
    skill.listAllConversations({ signal: AbortSignal.timeout(REACH_TIMEOUT_MS) })
  );
  const { data: projects } = useEntity<Project[]>(K.projects, skill.listProjects);
  const { data: runFeed } = useEntity<{ runs: Run[] }>(K.runs(ALL_SCOPE), () =>
    skill.listRuns({ limit: skill.RUN_LIMIT })
  );
  const live = useLiveChats();
  const reach = reachOf(useOnLine(), error);
  const saved = useSavedChats();

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') invalidate(K.allConversations);
    }, LIST_POLL_MS);
    return (): void => {
      clearInterval(id);
    };
  }, []);

  const chats = all?.chats ?? (reach === 'online' ? undefined : saved?.map(s => s.found));
  const statusSets = useMemo(
    () =>
      chatStatusSets(
        (chats ?? []).map(c => c.chat),
        {
          working: live.ids,
          runAwaiting: awaitingInputIds(runFeed?.runs ?? []),
          running: runningRunIds(runFeed?.runs ?? []),
          waiting: live.ciWaiting,
        }
      ),
    [chats, live.ids, live.ciWaiting, runFeed?.runs]
  );
  const statuses = useMemo(
    () =>
      chatStatuses(
        (chats ?? []).map(c => c.chat),
        statusSets
      ),
    [chats, statusSets]
  );

  const notifications = useMemo(
    () => chatNotifications(chats ?? [], statuses, statusSets.unread),
    [chats, statuses, statusSets.unread]
  );

  const names = useMemo(() => new Map((projects ?? []).map(p => [p.id, p.name])), [projects]);
  const savedLabels = useMemo(
    () => new Map((saved ?? []).map(s => [s.found.projectId, s.projectLabel])),
    [saved]
  );
  const label = useCallback(
    (projectId: string): string => {
      const name = names.get(projectId);
      if (name === undefined) {
        const offline = savedLabels.get(projectId);
        if (offline !== undefined) return offline;
      }
      return projectLabel(name ?? projectId, getDisplayName(projectId, name ?? projectId));
    },
    [names, savedLabels]
  );

  return {
    chats,
    error,
    reach,
    statusSets,
    statuses,
    notifications,
    needsYou: notifications.length,
    liveTools: live.tools,
    ciWaitingSince: live.ciWaitingSince,
    projectLabel: label,
  };
}
