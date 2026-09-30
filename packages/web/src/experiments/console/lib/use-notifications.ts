/**
 * What wants you, across every project (#289): the chats awaiting you and the
 * ones you have not read, with the statuses they were read from.
 *
 * One hook for the favicon badge (`use-tab-signal`) and the rail's bell, so the
 * number on the tab and the list behind the bell are the same computation. The
 * phone reads the same primitive through `useMobileChats`, whose scope is also
 * every project. Both read `useEntity` keys, so a second reader costs no
 * request.
 */
import { useMemo } from 'react';
import * as skill from '../skills';
import { invalidate, useEntity } from '../store/cache';
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
      items: chatNotifications(found, statuses, sets.unread),
      loaded: all !== undefined,
    };
  }, [found, all, live.ids, live.ciWaiting, runFeed?.runs]);
}

/**
 * Mark every unread notification read. An awaiting one is left alone: reading
 * a question does not answer it, and the list would only put it straight back.
 *
 * Every list is refreshed afterwards, including when some marks failed — the
 * ones that landed should leave the list either way. The first failure is
 * rethrown so the caller can say the list is not fully cleared.
 */
export async function markAllRead(items: readonly ChatNotification[]): Promise<void> {
  const results = await Promise.allSettled(
    items.filter(n => n.kind === 'unread').map(n => skill.markConversationRead(n.id))
  );
  invalidate('conversations');
  const failed = results.find(r => r.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
}
