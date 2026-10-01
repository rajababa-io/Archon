/**
 * What needs you, across every project (#289, #333): the chats awaiting you,
 * with the statuses they were read from.
 *
 * The favicon badge (`use-tab-signal`) reads this hook. The phone reads the
 * same primitive through `useMobileChats`, whose scope is also every project.
 */
import { useMemo } from 'react';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { ALL_SCOPE, K } from '../store/keys';
import { awaitingInputIds, chatStatusSets, runningRunIds } from '../primitives/chat-status';
import type { ChatStatus } from '../primitives/chat-status';
import type { Run } from '../primitives/run';
import { chatNotifications, chatStatuses, type ChatNotification } from '../primitives/tab-signal';
import { useLiveChats } from './live-chats';

export interface Notifications {
  /** Every project's chats, as the server listed them. */
  found: readonly skill.FoundChat[];
  statuses: ReadonlyMap<string, ChatStatus>;
  items: readonly ChatNotification[];
  /** The list has been read at least once; before that the count is not known. */
  loaded: boolean;
}

export function useNotifications(): Notifications {
  const { data: all } = useEntity(K.allConversations, () => skill.listAllConversations());
  const { data: runFeed } = useEntity<{ runs: Run[] }>(K.runs(ALL_SCOPE), () =>
    skill.listRuns({ limit: skill.RUN_LIMIT })
  );
  const live = useLiveChats();

  const found = useMemo(() => all?.chats ?? [], [all]);
  return useMemo(() => {
    const chats = found.map(f => f.chat);
    const sets = chatStatusSets(chats, {
      working: live.ids,
      runAwaiting: awaitingInputIds(runFeed?.runs ?? []),
      running: runningRunIds(runFeed?.runs ?? []),
      waiting: live.ciWaiting,
    });
    const statuses = chatStatuses(chats, sets);
    return {
      found,
      statuses,
      items: chatNotifications(found, statuses),
      loaded: all !== undefined,
    };
  }, [found, all, live.ids, live.ciWaiting, runFeed?.runs]);
}
