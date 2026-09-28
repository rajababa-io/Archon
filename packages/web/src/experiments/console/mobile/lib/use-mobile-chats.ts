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
import { chatStatuses, wantingCount } from '../../primitives/tab-signal';
import type { Project } from '../../primitives/project';
import type { Run } from '../../primitives/run';

/**
 * How often the chat list is re-read while the app is on screen.
 *
 * A backstop, as on the desktop chat page. The dashboard stream narrows
 * `conversation_changed` to one project's list key, which never reaches the
 * every-project list this reads, so a title the agent rewrote or a chat
 * created elsewhere would otherwise wait for the next lock event.
 */
const LIST_POLL_MS = 8000;

export interface MobileChats {
  chats: readonly skill.FoundChat[] | undefined;
  error: Error | undefined;
  statusSets: ChatStatusSets;
  statuses: ReadonlyMap<string, ChatStatus>;
  /** Chats that want you — the same count the desktop tab badge shows. */
  needsYou: number;
  /** What each working chat is running right now, when it is inside a tool. */
  liveTools: ReturnType<typeof useLiveChats>['tools'];
  ciWaitingSince: ReturnType<typeof useLiveChats>['ciWaitingSince'];
  projectLabel: (projectId: string) => string;
}

export function useMobileChats(): MobileChats {
  const { data: all, error } = useEntity(K.allConversations, skill.listAllConversations);
  const { data: projects } = useEntity<Project[]>(K.projects, skill.listProjects);
  const { data: runFeed } = useEntity<{ runs: Run[] }>(K.runs(ALL_SCOPE), () =>
    skill.listRuns({ limit: skill.RUN_LIMIT })
  );
  const live = useLiveChats();

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') invalidate(K.allConversations);
    }, LIST_POLL_MS);
    return (): void => {
      clearInterval(id);
    };
  }, []);

  const chats = all?.chats;
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

  const names = useMemo(() => new Map((projects ?? []).map(p => [p.id, p.name])), [projects]);
  const label = useCallback(
    (projectId: string): string => {
      const name = names.get(projectId) ?? projectId;
      return projectLabel(name, getDisplayName(projectId, name));
    },
    [names]
  );

  return {
    chats,
    error,
    statusSets,
    statuses,
    needsYou: wantingCount(statuses),
    liveTools: live.tools,
    ciWaitingSince: live.ciWaitingSince,
    projectLabel: label,
  };
}
