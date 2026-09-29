import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useLocation, useParams } from 'react-router';
import { ChatStream } from '../components/ChatStream';
import { ChatComposer, type ChatDraft } from '../components/ChatComposer';
import { QueuedMessages } from '../components/QueuedMessages';
import { chooseOpenChat, readLastChat, writeLastChat } from '../lib/last-chat';
import { readOpenChatRequest } from '../lib/open-chat';
import { ConversationRail, type ChatScope } from '../components/ConversationRail';
import { ChatStatusStrip } from '../components/ChatStatusStrip';
import { StatusDetails } from '../components/StatusDetails';
import { TurnChecklist } from '../components/TurnChecklist';
import { ChatRunsPanel } from '../components/ChatRunsPanel';
import { ChangesPanel } from '../components/ChangesPanel';
import { EmptyState } from '../components/EmptyState';
import { StreamContextProvider } from '../lib/stream-context';
import { useConversationSSE, type NextMessageSuggestion } from '../lib/sse';
import { useLiveChats } from '../lib/live-chats';
import { useEntity, invalidate } from '../store/cache';
import { ALL_SCOPE, K } from '../store/keys';
import { getDisplayName, projectLabel } from '../lib/display-name';
import type { Project } from '../primitives/project';
import {
  awaitingInputIds,
  chatStatus,
  chatStatusSets,
  runningRunIds,
  type ChatStatus,
} from '../primitives/chat-status';
import type { Run } from '../primitives/run';
import { baselineUserIds, echoHasLanded } from '../primitives/pending-echo';
import { useFollowTail } from '../hooks/useFollowTail';
import { useReadMarker } from '../hooks/useReadMarker';
import { useChatPresence } from '../hooks/useChatPresence';
import { useArrowScroll } from '../hooks/useArrowScroll';
import { useTurnControls } from '../hooks/useTurnControls';
import { modalIsOpen } from '../lib/keymap';
import { isNewChatKey } from '../lib/new-chat-key';
import { sentHistory } from '../lib/composer-history';
import { askAwaitsAnswer } from '../lib/ask-keys';
import { chatDraftKey, loadDraftText } from '../lib/draft-store';
import * as skill from '../skills';
import type { InlineToolCall, Message } from '../primitives/message';
import { reduceLive, type LiveSegment, type LiveEvent } from '../primitives/live-text';
import { renderedMessages, type PendingUser } from '../primitives/rendered-messages';
import { resolveConversationDbId } from '../primitives/conversation';
import { isChecklistCall, turnChecklist, type ChecklistCall } from '../primitives/checklist';

// While a turn is active, refetch messages on this cadence so streamed replies
// still surface if a per-conversation SSE event is dropped (cross-origin
// EventSource in dev can miss bursts). Mirrors RunDetailPage's safety-net poll.
const ACTIVE_POLL_MS = 3000;
/**
 * How long a send waits to be confirmed by the server before it stops counting
 * as working on its own.
 *
 * Only ever covers the gap between the request leaving and the server saying it
 * has the conversation — a lock event on this chat's own stream, or the next
 * read of /api/health. It is not a guess about how long a turn takes: once
 * either of those lands, they own the state until the turn ends.
 *
 * There used to be a settle timer here instead, which called the turn over once
 * the trailing assistant message had been stable for six seconds. That is the
 * bug this screen is named after: an agent that says "let me look" and then
 * reads files for two minutes produced exactly that shape, so the indicator
 * vanished and the chat sat there looking finished while it worked.
 */
const CONFIRM_WAIT_MS = 20_000;
// Hard cap so a turn that never produces a reply (server error, etc.) can't
// disable the composer forever.
const MAX_WAIT_MS = 300_000;
// Refresh the CHAT LIST on this cadence while the tab is visible.
//
// A backstop now, not the mechanism. The dashboard stream pushes
// `conversation_changed` (Postgres) and `conversation_lock` (every backend),
// and useDashboardSSE invalidates this key on both, so a reply landing in a
// chat you are NOT viewing, a title the agent rewrote, or a chat created by
// the CLI appears without a refresh. This covers what a push cannot: a closed
// stream, and a rename on SQLite, where there are no triggers and so no
// `conversation_changed` at all. Gated on visibility so a background tab
// costs nothing.
const LIST_POLL_MS = 8000;

/**
 * What Refresh sends. A visible user message rather than a silent back-channel:
 * the agent's summary tool writes to the chat's own record, so the request that
 * caused it should be readable in the transcript next to the result.
 */
/**
 * Project-scoped agent chat. A tab peer of the runs view under a project.
 *
 * MVP conversation model: one active conversation per project — the most-recent
 * web conversation, or created lazily on first send. No multi-conversation
 * sidebar yet (spike decision #3, deferred).
 *
 * Data flow mirrors RunDetailPage: load messages via useEntity(K.messages),
 * keep live via useConversationSSE (invalidate → refetch), render with the
 * shared MessageItem/ToolCallItem cards inside a StreamContextProvider.
 */
export function ChatPage(): ReactElement {
  // No project in the route is the All projects page's Chat tab: every
  // project's chats in one rail. The chat being read then supplies the project
  // — its runs, its draft, its slash commands — so everything below that needs
  // one reads `projectId`, and only the list and the rail read the route.
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const everyProject = routeProjectId === undefined;
  const listScope = routeProjectId ?? ALL_SCOPE;

  // Which lifecycle scope the rail is showing. Part of the cache key, or
  // switching scope would render the previous scope's list.
  const [scope, setScope] = useState<ChatScope>('open');
  const { data: conversationList, error: conversationsError } = useEntity<skill.ConversationList>(
    `${K.conversations(listScope)}:${scope}`,
    () => skill.listConversations(routeProjectId ?? null, scope)
  );
  const conversations = conversationList?.chats;
  // Every scope's size arrives with whichever scope is being shown, so the
  // tabs can be labelled without a second read. Counted server-side rather
  // than measured here: the listing is capped, and done is the scope that
  // outgrows any cap.
  const counts = conversationList?.counts ?? skill.EMPTY_CONVERSATION_LIST.counts;

  // Active conversation: most-recent web conversation, else null until first send.
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const activeConversation = (conversations ?? []).find(c => c.id === activeConvId);
  const projectId = routeProjectId ?? activeConversation?.projectId ?? undefined;

  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  const labelOf = useCallback(
    (id: string): string => {
      const name = (projects ?? []).find(p => p.id === id)?.name ?? id;
      return projectLabel(name, getDisplayName(id, name));
    },
    [projects]
  );
  // Set when the user asks for a new chat. Without it the auto-select effect
  // below would immediately put them back in the most recent conversation, so
  // the button would appear to do nothing.
  const [startingNew, setStartingNew] = useState(false);
  // Bumped on every new-chat request, including one made while already on a
  // new chat, so the composer is focused each time and not only on the first.
  const [newChatRequests, setNewChatRequests] = useState(0);
  // Switching project must release the previous project's conversation. The
  // auto-select effect below only fires when activeConvId is null, so without
  // this the page kept showing a chat belonging to the project just left.
  useEffect(() => {
    setActiveConvId(null);
    setStartingNew(false);
    setSending(false);
    setPendingUser(null);
  }, [routeProjectId]);

  useEffect(() => {
    if (activeConvId !== null || startingNew) return;
    const web = (conversations ?? []).filter(c => c.platformType === 'web');
    if (web.length === 0) return;
    // byMostRecent already ordered the list, so [0] is the newest.
    const open = chooseOpenChat(readLastChat(listScope), web);
    if (open !== null) setActiveConvId(open);
  }, [conversations, activeConvId, startingNew, listScope]);

  const selectConversation = (id: string | null): void => {
    setError(null);
    setStartingNew(id === null);
    if (id === null) setNewChatRequests(n => n + 1);
    setActiveConvId(id);
    // `sending` describes the conversation being read, not the page. Leaving it
    // set while switching made one chat's pending reply lock every other chat
    // in the project. The lock itself needs no reset: it is keyed by
    // conversation, so the new chat reads its own answer.
    setSending(false);
    sawServerWorkingRef.current = false;
    // The echo belongs to the chat it was typed in, not to the page.
    setPendingUser(null);
    writeLastChat(listScope, id);
  };

  const selectConversationRef = useRef(selectConversation);
  selectConversationRef.current = selectConversation;

  // A chat asked for by name from elsewhere — the ⌘K palette. Declared after
  // the project-change reset above so that, arriving from another project, the
  // reset runs first and this choice is the one that stands. A done chat also
  // moves the rail to the done scope, where it is listed.
  const location = useLocation();
  useEffect(() => {
    const request = readOpenChatRequest(location.state);
    if (request === null) return;
    setScope(request.done ? 'done' : 'open');
    selectConversationRef.current(request.openChat);
  }, [location.key, location.state]);

  const invalidateConversationsRef = useRef<() => void>(() => undefined);

  const invalidateConversations = (): void => {
    invalidate(`${K.conversations(listScope)}:${scope}`);
    invalidate(K.conversations(listScope));
    // A chat changed from the every-project list is also in its own
    // project's list, which the project header's count reads.
    if (everyProject && projectId !== undefined) invalidate(K.conversations(projectId));
    // The tab badge counts every project's chats, so a read or unread mark
    // made here has to reach that list too.
    invalidate(K.allConversations);
  };
  invalidateConversationsRef.current = invalidateConversations;

  // Keep the chat list fresh without a manual refresh. The ref keeps the
  // interval stable across renders: depending on the callback itself would tear
  // the timer down and rebuild it on every keystroke in the composer.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      invalidateConversationsRef.current();
    }, LIST_POLL_MS);
    // Catch up immediately on returning to the tab rather than waiting out the
    // remainder of an interval that ran while it was hidden.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') invalidateConversationsRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return (): void => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [listScope]);

  /**
   * Mark a chat's unit of work finished, or reopen it.
   *
   * Marking the chat you are READING done drops it out of the list the rail is
   * showing, so the page has to move — but to the neighbour the rail named,
   * not to a blank new chat. Being ejected to the composer every time you tick
   * one off turns clearing a rail into a fight.
   *
   * Which way removes it depends on the scope: under `Open` it is finishing,
   * under `Done` it is reopening, and under `All` neither — the chat stays
   * listed either way.
   */
  const completeConversation = (id: string, completed: boolean, next: string | null): void => {
    void (async (): Promise<void> => {
      try {
        await skill.setConversationCompleted(id, completed);
        const leavesList = scope === 'open' ? completed : scope === 'done' ? !completed : false;
        if (leavesList && activeConvId === id) {
          selectConversation(next);
        }
        invalidateConversations();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Could not change the done state.');
      }
    })();
  };

  const markConversationUnread = (id: string): void => {
    // Marking the chat you are on would be undone by the mark-read effect the
    // moment the list refreshes. Claim its current pair first, so the mark
    // holds until you open the chat again or it says something new.
    if (id === activeConvId) {
      readMarker.holdUnread(
        id,
        (conversations ?? []).find(c => c.id === id)?.lastActivityAt ?? null
      );
    }
    void (async (): Promise<void> => {
      try {
        await skill.markConversationUnread(id);
        invalidateConversations();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Could not mark the chat unread.');
      }
    })();
  };

  /**
   * Persist the rail's arrangement.
   *
   * Fire-and-forget on purpose: the rail already shows the new order, so
   * waiting would only delay the list catching up. A failure surfaces on the
   * page — an arrangement that silently did not save is one the user finds out
   * about on their next machine.
   */
  const reorderConversations = (ids: string[]): void => {
    void (async (): Promise<void> => {
      try {
        await skill.setConversationOrder(ids);
        invalidateConversations();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Could not save the chat order.');
      }
    })();
  };

  const renameConversation = (id: string, title: string): void => {
    void (async (): Promise<void> => {
      try {
        await skill.renameConversation(id, title);
        invalidateConversations();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Rename failed.');
      }
    })();
  };

  // Derived rather than tracked as second state, so the platform id and the DB
  // uuid can't drift apart.
  const activeConvDbId = useMemo<string | null>(
    () => resolveConversationDbId(conversations ?? [], activeConvId),
    [conversations, activeConvId]
  );

  const { data: messages, error: messagesError } = useEntity<Message[]>(
    activeConvId !== null ? K.messages(activeConvId) : 'noop:no-conv',
    () => (activeConvId !== null ? skill.listMessages(activeConvId) : Promise.resolve([]))
  );

  /**
   * The server holds this conversation's lock — it is executing a turn.
   *
   * Read from a cache key, not from component state. While the stream is up
   * the `conversation_lock` events on this chat's own stream write it, and
   * they bracket the turn exactly: `true` when the handler starts, `false` in
   * its `finally`. A reconnect refetches it from the server, which is what an
   * unlock emitted while the socket was down no longer strands — see
   * `lib/sse.ts`. Nothing polls it.
   */
  const { data: lock } = useEntity<skill.ConversationLock>(
    activeConvId !== null ? K.conversationLock(activeConvId) : 'noop:no-conv-lock',
    () =>
      activeConvId !== null
        ? skill.getConversationLock(activeConvId)
        : Promise.resolve({ conversationId: '', locked: false })
  );
  const locked = lock?.locked ?? false;
  /**
   * This tab just sent, and no authority has confirmed it yet.
   *
   * Covers the one gap the server's answers cannot: the round trip between the
   * send leaving and the lock event coming back. Expires on its own so a send
   * the server never picked up cannot leave the composer disabled.
   */
  const [sending, setSending] = useState(false);
  // The user's own message, echoed the instant they send it rather than when
  // the server has stored it. Without this the first message of a new chat is
  // invisible for the whole create-and-upload round trip — the composer clears,
  // nothing takes its place, and a slow upload reads as a failed send. The echo
  // carries the attachments too, so the file chips appear with the text.
  const [pendingUser, setPendingUser] = useState<PendingUser | null>(null);
  /**
   * The user-row IDs the conversation held when the echo was raised.
   *
   * Identity, not a count. Counting compared against a baseline read out of a
   * render closure, so a `messages` that was one refetch stale left the
   * baseline too high — the count then never exceeded it, the echo never
   * retired, and the message appeared twice with timestamps a second apart.
   * One of them was never a second message: only one row was ever persisted.
   *
   * An id that was not there before is unambiguous. It survives a stale read,
   * the same text being sent twice, and the new-chat id switch that empties the
   * list before the real row lands.
   */
  const pendingBaseRef = useRef<ReadonlySet<string>>(new Set());
  // Keyed by conversation — a pending chat has no id yet, so it gets its own
  // slot. Held in the composer this followed the user between chats.
  const [drafts, setDrafts] = useState<Record<string, ChatDraft>>({});
  const draftKey = chatDraftKey(projectId ?? null, activeConvId ?? null);
  const draft = drafts[draftKey] ?? { text: loadDraftText(draftKey), files: [] };
  const setDraft = (next: ChatDraft): void => {
    setDrafts(prev => ({ ...prev, [draftKey]: next }));
  };
  const [error, setError] = useState<string | null>(null);
  // Non-error advisory (distinct channel from `error` so it doesn't read as a
  // send failure) — e.g. files dropped from a first message.

  // The lock going up is the server confirming it has this turn, so the
  // unconfirmed-send flag has nothing left to cover. Driven off the lock value
  // rather than off the event, so a lock learned from the reconnect refetch
  // retires the flag exactly as a live event does.
  useEffect(() => {
    if (locked) setSending(false);
  }, [locked]);
  // Streamed text that has not been written to the database yet. The server
  // holds assistant text in memory and persists it late, so without this the
  // reply is invisible until a flush — the reload-to-see-it bug. See
  // `primitives/live-text.ts` for why persisting sooner is not the fix.
  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  // Checklist tool calls streamed this turn, for the same reason: tool calls
  // are written when the turn ends, and the checklist is only worth showing
  // while it runs. See `primitives/checklist.ts`.
  const [liveChecklist, setLiveChecklist] = useState<ChecklistCall[]>([]);
  const onLive = useCallback((event: LiveEvent): void => {
    setLiveSegments(prev => reduceLive(prev, event));
    if (
      event.kind === 'tool' &&
      event.name !== undefined &&
      isChecklistCall({ name: event.name })
    ) {
      const call: ChecklistCall = { name: event.name, input: event.input ?? {} };
      setLiveChecklist(prev => [...prev, call]);
    }
  }, []);

  // The last finished turn's suggested next message. Belongs to this chat only,
  // and to the gap between turns: the next turn starting retires it.
  const [suggestion, setSuggestion] = useState<NextMessageSuggestion | null>(null);
  useConversationSSE(activeConvId, onLive, setSuggestion);

  // Switching chats must not carry one conversation's preview into another.
  useEffect(() => {
    setLiveSegments([]);
    setLiveChecklist([]);
    setSuggestion(null);
  }, [activeConvId]);

  // A turn the server starts on its own — a queued message — begins with the
  // lock going up and no send from this page, so that edge is what retires the
  // last turn's streamed checklist calls. Applied again under the new turn,
  // every `TaskCreate` among them would be a duplicate item.
  const wasLockedRef = useRef(locked);
  useEffect(() => {
    if (locked && !wasLockedRef.current) {
      setLiveChecklist([]);
      setSuggestion(null);
    }
    wasLockedRef.current = locked;
  }, [locked]);

  // A send that nothing ever confirmed stops speaking for itself. Without this
  // a request the server dropped would hold the composer shut until the page
  // was reloaded.
  useEffect(() => {
    if (!sending) return;
    const id = setTimeout(() => {
      setSending(false);
    }, CONFIRM_WAIT_MS);
    return (): void => {
      clearTimeout(id);
    };
  }, [sending]);

  // Retire the echo the moment the server's own copy of the message arrives.
  // Counting user rows rather than matching content: the same text sent twice
  // would otherwise clear the second echo against the first message's row.
  useEffect(() => {
    if (pendingUser === null) return;
    if (echoHasLanded(messages ?? [], pendingBaseRef.current)) setPendingUser(null);
  }, [messages, pendingUser]);

  // Which chats the SERVER says it is working on — including ones you are not
  // looking at. Pushed on the dashboard stream the moment a chat starts or
  // stops (see lib/sse.ts); the hook's own poll is the backstop for what a push
  // cannot reach, shared with every other reader of the same answer.
  const { ids: liveIds, tools: liveTools, ciWaiting, ciWaitingSince } = useLiveChats();
  // Only the CI alarm is read from it. The settings page owns the same cache
  // key, so a saved change reaches this chip without a reload.
  const { data: config } = useEntity(K.config, skill.getConfig);
  const ciAlarmMinutes = config?.config.chats?.ciWaitAlarmMinutes;

  /**
   * Chats whose run is paused on an approval.
   *
   * Reads the PROJECT's runs feed, not the open chat's: this marks every chat
   * in the rail, including the ones you are not looking at. An approval belongs
   * to a RUN, and the run is what knows which conversation dispatched it; there
   * is no way to ask a conversation directly.
   */
  const { data: runFeed } = useEntity<{ runs: Run[] }>(K.runs(listScope), () =>
    skill.listRuns(
      routeProjectId === undefined
        ? { limit: skill.RUN_LIMIT }
        : { codebaseId: routeProjectId, limit: skill.RUN_LIMIT }
    )
  );
  const awaitingIds = useMemo(() => awaitingInputIds(runFeed?.runs ?? []), [runFeed?.runs]);
  // The same feed, for chats whose run is moving rather than asking.
  const runningIds = useMemo(() => runningRunIds(runFeed?.runs ?? []), [runFeed?.runs]);

  /**
   * Is THIS chat working?
   *
   * Three sources, none of them a guess about message shape. The lock event is
   * the precise one. /api/health is the one that survives a dropped stream, a
   * reload mid-turn, a second window, and a chat being driven from Slack or the
   * CLI. `sending` covers only the round trip before either can have answered.
   *
   * What is deliberately NOT here is any inference from the transcript. An
   * agent that posts "let me look at that" and then reads files for two minutes
   * has a trailing assistant message the whole time, and reading that as "the
   * turn is over" is what made this screen look finished while it worked.
   */
  const serverWorking = activeConvId !== null && liveIds.has(activeConvId);
  const working = sending || locked || serverWorking;
  // Stop, queue and take back. Its own hook so the page only routes to it.
  const turn = useTurnControls(activeConvId, locked);

  // After the commit, not in selectConversation: the composer is keyed by
  // conversation and remounts on the switch, so the element to focus only
  // exists once this render has landed.
  useEffect(() => {
    if (newChatRequests > 0) turn.controlRef.current?.focus();
  }, [newChatRequests, turn.controlRef]);

  // ⌘⇧O starts a new chat. A window listener, not the keymap: the keymap is
  // off while the composer has focus, which on this page is nearly always.
  useEffect(() => {
    // A new chat is started inside a project; the every-project list has none.
    if (everyProject) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!isNewChatKey(e) || modalIsOpen()) return;
      e.preventDefault();
      selectConversationRef.current(null);
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [everyProject]);

  /**
   * A correction for the gap a reconnect does not cover: the stream stays UP
   * and the release event is simply never seen. /api/health is polled and so
   * cannot be missed — once it has seen this turn and stopped seeing it, the
   * release event is not coming.
   *
   * It invalidates rather than asserting. The composer's lock has one
   * authority, and this says "ask it again", never "the answer is false" —
   * a second writer of the same value is how the two drift apart.
   */
  const sawServerWorkingRef = useRef(false);
  useEffect(() => {
    if (serverWorking) {
      sawServerWorkingRef.current = true;
      return;
    }
    if (!sawServerWorkingRef.current) return;
    sawServerWorkingRef.current = false;
    if (activeConvId !== null) invalidate(K.conversationLock(activeConvId));
  }, [serverWorking, activeConvId]);

  // The rail reads the server's list; this chat also knows its own unconfirmed
  // send, so its dot lights on the keystroke rather than on the next poll.
  const railLiveIds = useMemo<ReadonlySet<string>>(() => {
    if (activeConvId === null || !working || liveIds.has(activeConvId)) return liveIds;
    return new Set([...liveIds, activeConvId]);
  }, [liveIds, activeConvId, working]);

  /**
   * Every status input, built once. The rail's dots and the status bar under
   * the open chat both read THIS object — neither assembles its own — so the bar cannot say one thing while the dot beside it says
   * another (#217).
   *
   * The chat on screen is included in `unread` rather than exempted: being open
   * is not the same as having been read, which is the whole point of clearing
   * the mark at the BOTTOM of the stream.
   */
  const statusSets = useMemo(
    () =>
      chatStatusSets(conversations ?? [], {
        working: railLiveIds,
        runAwaiting: awaitingIds,
        running: runningIds,
        waiting: ciWaiting,
      }),
    [conversations, railLiveIds, awaitingIds, runningIds, ciWaiting]
  );
  const unread = statusSets.unread;

  /** The status of the chat being READ — the same call, on the same sets, as
   * its row in the rail. */
  const status: ChatStatus = activeConvId === null ? 'idle' : chatStatus(activeConvId, statusSets);

  // Belt and braces: an echo must never outlive its turn. If the reply has
  // landed and released the composer, whatever the echo was waiting for is
  // not coming — showing it alongside the stored message is the visible bug.
  useEffect(() => {
    if (!working && pendingUser !== null) setPendingUser(null);
  }, [working, pendingUser]);

  /**
   * When the clock starts.
   *
   * A turn this tab began has an exact start. One it did not — a reload, a
   * second window, a chat driven from Slack — has no knowable start, so the
   * clock counts from the last thing that was SAID instead. That is not a
   * guess dressed as precision: it is exactly the number worth reading during
   * a long silent stretch, because it is how long the silence has lasted.
   *
   * Held as state rather than derived, because it must be pinned at the moment
   * the turn began: recomputing it would restart the clock on every refetch.
   */
  const [workingSince, setWorkingSince] = useState<number | null>(null);
  const lastActivityAt =
    (conversations ?? []).find(c => c.id === activeConvId)?.lastActivityAt ?? null;
  const lastActivityRef = useRef<string | null>(null);
  lastActivityRef.current = lastActivityAt;
  useEffect(() => {
    if (!working) {
      setWorkingSince(null);
      return;
    }
    setWorkingSince(prev => {
      // Already ticking — including the exact start `onSend` stamped for a turn
      // this tab began. Recomputing here would restart that clock at the wrong
      // moment, and replace a known start with an inferred one.
      if (prev !== null) return prev;
      const said = lastActivityRef.current;
      const t = said === null ? Number.NaN : Date.parse(said);
      return Number.isNaN(t) ? Date.now() : t;
    });
  }, [working]);

  // Recovery poll: while a reply is pending, refetch messages on a cadence so a
  // dropped or absent SSE event can't hide the reply. Hard-caps at MAX_WAIT_MS
  // so a turn the server forgot about cannot poll for ever.
  useEffect(() => {
    if (!working || activeConvId === null) return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        clearInterval(id);
        return;
      }
      invalidate(K.messages(activeConvId));
    }, ACTIVE_POLL_MS);
    return (): void => {
      clearInterval(id);
    };
  }, [working, activeConvId]);

  // Reveal the turn's tool trace under the status strip.
  const [showTools, setShowTools] = useState(false);

  // Follow the tail by observed height, not by message count: a streaming reply,
  // late markdown/code highlighting and expanding tool cards all grow an existing
  // row without adding one, and a count-keyed effect never sees them.
  const { scrollRef, contentRef, atBottom, scrollToBottom, scrollerProps, noteUserIntent } =
    useFollowTail();
  // ↑/↓ scroll the transcript. The composer re-focuses itself after each send,
  // so without this the arrows land in an empty textarea and do nothing.
  useArrowScroll(scrollRef, { onUserScroll: noteUserIntent });

  useChatPresence(activeConvId);
  const readMarker = useReadMarker({
    conversationId: activeConvId,
    lastActivityAt,
    working,
    unread,
    onMarked: () => {
      invalidateConversationsRef.current();
    },
  });

  // Held in a ref so `onAnswer` below can be referentially stable without
  // threading every dependency of onSend through a useCallback. Memoized
  // message items compare this prop, so an inline lambda here would defeat
  // the memo entirely — the thing it is there to prevent.
  const onSendRef = useRef<(text: string, files?: File[]) => void>(() => undefined);

  const onSend = (text: string, files?: File[]): void => {
    if (projectId === undefined) return;
    // Sending while the agent works queues behind the turn on the server; the
    // queued bubble, not the optimistic echo, is what shows it.
    if (working && activeConvId !== null) {
      turn.queueSend(text, files);
      return;
    }
    setError(null);
    // The reader may be up in the history; their own message is the one thing
    // they always want to see land, so sending re-pins the tail.
    scrollToBottom();
    setLiveSegments([]); // a new turn — the previous reply is history now
    setLiveChecklist([]);
    setSending(true); // optimistic: disable the composer immediately
    setWorkingSince(Date.now()); // this turn has a known start, not an inferred one
    // Show the message (and its attachments) before the request leaves.
    pendingBaseRef.current = baselineUserIds(messages ?? []);
    setPendingUser({
      content: text,
      files: (files ?? []).map(f => ({ name: f.name, mimeType: f.type, size: f.size })),
    });
    void (async (): Promise<void> => {
      try {
        if (activeConvId === null) {
          const conv = await skill.createConversation(projectId, text, files);
          setActiveConvId(conv.conversationId);
          setStartingNew(false);
          writeLastChat(projectId, conv.conversationId);
          invalidate(K.messages(conv.conversationId));
        } else {
          const dispatch = await skill.sendMessage(activeConvId, text, files);
          // The server can queue a message this page thought would start at
          // once — it is at its concurrency cap, or a turn began that the
          // page had not heard of yet. The queued bubble then shows it, so the
          // echo goes: both at once read as the message sent twice.
          if (dispatch.queuedId !== undefined) setPendingUser(null);
          invalidate(K.messages(activeConvId));
        }
        // Sending can change the conversation list, not just its messages: a
        // new chat appears in it, and sending to an archived chat un-archives
        // it server-side. Without this the rail kept showing the chat as
        // archived and the count never moved.
        invalidateConversations();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Send failed.');
        setSending(false); // unblock so the user can retry
        setPendingUser(null); // nothing was sent — the echo would be a lie
      }
      // On success the server takes over: its lock event, or its active-chat
      // list, says when the turn is done. Nothing here guesses.
    })();
  };

  const messageList = messages ?? [];
  // Which chat's summary is open, and whether it opened straight into the
  // editor. Keyed by conversation id rather than a boolean: the rail can open
  // the summary of a chat that is not the one being read.

  // Surface a failed (re)load of the conversation list or message history — a
  // revalidation can fail silently (network blip, server restart) and otherwise
  // leave stale/empty data with no signal. Send errors take precedence.
  const loadError = messagesError ?? conversationsError;

  // What actually renders: the persisted rows, the user's echo, then the
  // streamed text the database has not caught up with.
  const rendered = useMemo<Message[]>(
    () => renderedMessages(messageList, pendingUser, liveSegments, new Date().toISOString()),
    [messageList, liveSegments, pendingUser]
  );

  // Cheap enough to derive per render; the composer re-renders with the page anyway.
  const sent = sentHistory(rendered);
  const askWaiting = !working && askAwaitsAnswer(rendered);

  /** Up in an empty message box: the newest answerable card takes the keyboard. */
  const reachAsk = (): void => {
    const cards = scrollRef.current?.querySelectorAll<HTMLElement>('[data-ask-live]');
    cards?.[cards.length - 1]?.focus();
  };
  /** Escape in an ask card: back to the message box. */
  const leaveAsk = useCallback((): void => {
    turn.controlRef.current?.focus();
  }, [turn.controlRef]);

  onSendRef.current = onSend;

  /** Stable across renders; flips only between itself and `undefined`. */
  const answerAsk = useCallback((text: string, files?: File[]): void => {
    onSendRef.current(text, files);
  }, []);

  /**
   * Every tool the current turn has invoked, oldest first.
   *
   * "The current turn" is everything after the last user message, so while the
   * chat is idle this is the last turn's trace instead — which is the one you
   * want when the question is "what did it just do". The whole input is carried,
   * not the name: `Bash` alone cannot say whether it is building or committing.
   */
  const turnTrace = useMemo<InlineToolCall[]>(() => {
    const out: InlineToolCall[] = [];
    for (let i = messageList.length - 1; i >= 0; i--) {
      const m = messageList[i];
      if (m === undefined) continue;
      if (m.role === 'user') break;
      out.unshift(...m.toolCalls);
    }
    return out;
  }, [messageList]);

  // Read from the rendered list so the user's own echo already counts as the
  // turn boundary — the checklist of the turn before disappears on send, not
  // on the refetch after it.
  const checklist = useMemo(
    () => turnChecklist(rendered, liveChecklist),
    [rendered, liveChecklist]
  );

  return (
    <section className="flex h-full min-h-0 flex-row">
      <ConversationRail
        // Remounted per project: the filter text, the selection and any open
        // menu all name chats in the project being left.
        key={listScope}
        conversations={conversations ?? []}
        omitted={
          conversationList === undefined
            ? 0
            : conversationList.total - conversationList.chats.length
        }
        openCount={counts.open}
        statusSets={statusSets}
        activeConvId={activeConvId}
        onSelect={selectConversation}
        onRename={renameConversation}
        onComplete={completeConversation}
        onMarkUnread={markConversationUnread}
        onReorder={reorderConversations}
        scope={scope}
        onScopeChange={setScope}
        doneCount={counts.done}
        pendingNew={startingNew && activeConvId === null}
        projectId={routeProjectId ?? null}
        projectLabel={labelOf}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            {...scrollerProps}
            className="h-full overflow-y-auto px-[var(--chat-pad)] pt-[var(--chat-pad)] pb-[var(--msg-gap)]"
          >
            {/* Match the composer's centered 940px column (design: .stream-inner) */}
            <div ref={contentRef} className="mx-auto max-w-[940px]">
              {rendered.length === 0 && !working ? (
                everyProject && activeConvId === null ? (
                  <EmptyState
                    title="Pick a chat."
                    hint="Every project's chats are on the left. A new chat starts inside its project."
                  />
                ) : (
                  <EmptyState
                    title={activeConvId === null ? 'New chat.' : 'No messages yet.'}
                    hint="Ask the agent about this project, or tell it what to run."
                  />
                )
              ) : (
                <StreamContextProvider
                  value={{
                    runStartedAt: null,
                    assistant: activeConversation?.assistant ?? null,
                    leaveAsk,
                  }}
                >
                  <ChatStream messages={rendered} onAnswer={working ? undefined : answerAsk} />
                  {/* Rendered in every state, including idle. A strip that only
                      appears while working cannot be trusted to be absent for
                      the right reason — and an empty screen is exactly what a
                      broken indicator looks like. */}
                  {activeConvId !== null || working ? (
                    <ChatStatusStrip
                      status={status}
                      since={workingSince}
                      ciSince={
                        activeConvId === null ? null : (ciWaitingSince[activeConvId] ?? null)
                      }
                      ciAlarmMinutes={ciAlarmMinutes}
                      lastActivityAt={lastActivityAt}
                      trace={turnTrace}
                      /* What it is doing, from the server's own map rather
                         than from rows that do not exist yet: tool calls are
                         written when the turn ENDS, so the trace is empty for
                         exactly the stretch this line is read. */
                      live={activeConvId === null ? null : (liveTools[activeConvId] ?? null)}
                      expanded={showTools}
                      onToggle={() => {
                        setShowTools(v => !v);
                      }}
                      /* On the strip's own line, because how full the chat is
                         is the other half of what it is doing: whether to keep
                         going here or start somewhere fresh. */
                      trailing={
                        <StatusDetails
                          conversationId={activeConvId}
                          messages={rendered}
                          turnKey={`${String(working)}:${rendered.at(-1)?.id ?? ''}`}
                        />
                      }
                    />
                  ) : null}
                  {checklist !== null ? <TurnChecklist items={checklist} /> : null}
                  <QueuedMessages
                    messages={turn.queued}
                    busyIds={turn.busyIds}
                    onEdit={turn.edit}
                    onRemove={turn.remove}
                    steerable={turn.steerable}
                    onSteer={turn.steer}
                  />
                </StreamContextProvider>
              )}
            </div>
          </div>
          {!atBottom ? (
            <button
              type="button"
              onClick={scrollToBottom}
              aria-label="Jump to bottom"
              className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface-elevated px-3 py-1 text-small text-text-secondary shadow-md transition-colors hover:text-text-primary"
            >
              <span aria-hidden>↓</span>
              Jump to bottom
            </button>
          ) : null}
        </div>

        {activeConvDbId !== null && projectId !== undefined ? (
          <ChatRunsPanel conversationDbId={activeConvDbId} projectId={projectId} />
        ) : null}

        {error !== null || loadError !== undefined ? (
          <div className="shrink-0 border-t border-error/30 bg-error/[0.06] px-4.75 py-1.25 text-small text-error">
            {error ?? `Failed to load chat: ${loadError?.message ?? 'unknown error'}`}
          </div>
        ) : null}

        {turn.notice !== null ? (
          <div
            role="status"
            className="shrink-0 border-t border-border bg-surface px-4.75 py-1.25 text-small text-text-secondary"
          >
            {turn.notice}
          </div>
        ) : null}

        {/* No composer with nothing to send to: the every-project list
            cannot start a chat, because a chat has to belong to a project. */}
        {projectId === undefined ? null : (
          <>
            {/* Keyed by conversation: the composer holds its own in-flight text, so
            switching chats must remount it to reseed from that chat's draft. */}
            <ChatComposer
              key={draftKey}
              onSend={onSend}
              draft={draft}
              onDraftChange={setDraft}
              working={working}
              onStop={activeConvId === null ? undefined : turn.stop}
              stopping={turn.stopping}
              onPullBack={turn.pullBackLast}
              onReachAsk={askWaiting ? reachAsk : undefined}
              controlRef={turn.controlRef}
              draftKey={draftKey}
              history={sent}
              projectId={projectId}
              suggestion={working ? null : suggestion}
              chat={
                activeConversation !== undefined
                  ? {
                      conversationId: activeConversation.id,
                      provider: activeConversation.assistant,
                    }
                  : undefined
              }
            />
          </>
        )}
      </div>
      {activeConvId !== null ? (
        <ChangesPanel conversationId={activeConvId} working={working} />
      ) : null}
    </section>
  );
}
