import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useParams } from 'react-router';
import { ChatStream } from '../components/ChatStream';
import { ChatComposer, type ChatDraft } from '../components/ChatComposer';
import { QueuedMessages } from '../components/QueuedMessages';
import { chooseOpenChat, readLastChat, writeLastChat } from '../lib/last-chat';
import { ConversationRail, type ChatScope } from '../components/ConversationRail';
import { ChatStatusStrip } from '../components/ChatStatusStrip';
import { ContextBar } from '../components/ContextBar';
import { ChatRunsPanel } from '../components/ChatRunsPanel';
import { EmptyState } from '../components/EmptyState';
import { StreamContextProvider } from '../lib/stream-context';
import { useConversationSSE } from '../lib/sse';
import { useLiveChats } from '../lib/live-chats';
import { usePageVisible } from '../lib/use-page-visible';
import { useTabSignal } from '../lib/use-tab-signal';
import { chatStatuses } from '../primitives/tab-signal';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import {
  awaitingInputIds,
  chatStatus,
  completedIds,
  readyIds,
  unreadIds,
  type ChatStatus,
} from '../primitives/chat-status';
import type { Run } from '../primitives/run';
import { baselineUserIds, echoHasLanded } from '../primitives/pending-echo';
import { useFollowTail } from '../hooks/useFollowTail';
import { useArrowScroll } from '../hooks/useArrowScroll';
import { useTurnControls } from '../hooks/useTurnControls';
import { sentHistory } from '../lib/composer-history';
import { loadDraftText } from '../lib/draft-store';
import * as skill from '../skills';
import type { InlineToolCall, Message } from '../primitives/message';
import {
  reduceLive,
  pendingSegments,
  type LiveSegment,
  type LiveEvent,
} from '../primitives/live-text';
import { resolveConversationDbId } from '../primitives/conversation';

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
  const { projectId } = useParams<{ projectId: string }>();

  // Which lifecycle scope the rail is showing. Part of the cache key, or
  // switching scope would render the previous scope's list.
  const [scope, setScope] = useState<ChatScope>('open');
  const { data: conversationList, error: conversationsError } = useEntity<skill.ConversationList>(
    projectId !== undefined ? `${K.conversations(projectId)}:${scope}` : 'noop:no-project-convs',
    () =>
      projectId !== undefined
        ? skill.listConversations(projectId, scope)
        : Promise.resolve(skill.EMPTY_CONVERSATION_LIST)
  );
  const conversations = conversationList?.chats;
  // Every scope's size arrives with whichever scope is being shown, so the
  // tabs can be labelled without a second read. Counted server-side rather
  // than measured here: the listing is capped, and done is the scope that
  // outgrows any cap.
  const counts = conversationList?.counts ?? skill.EMPTY_CONVERSATION_LIST.counts;

  // Active conversation: most-recent web conversation, else null until first send.
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  // Set when the user asks for a new chat. Without it the auto-select effect
  // below would immediately put them back in the most recent conversation, so
  // the button would appear to do nothing.
  const [startingNew, setStartingNew] = useState(false);
  // Switching project must release the previous project's conversation. The
  // auto-select effect below only fires when activeConvId is null, so without
  // this the page kept showing a chat belonging to the project just left.
  useEffect(() => {
    setActiveConvId(null);
    setStartingNew(false);
    setSending(false);
    setPendingUser(null);
  }, [projectId]);

  useEffect(() => {
    if (activeConvId !== null || startingNew || projectId === undefined) return;
    const web = (conversations ?? []).filter(c => c.platformType === 'web');
    if (web.length === 0) return;
    // byMostRecent already ordered the list, so [0] is the newest.
    const open = chooseOpenChat(readLastChat(projectId), web);
    if (open !== null) setActiveConvId(open);
  }, [conversations, activeConvId, startingNew, projectId]);

  const selectConversation = (id: string | null): void => {
    setError(null);
    setStartingNew(id === null);
    setActiveConvId(id);
    // `sending` describes the conversation being read, not the page. Leaving it
    // set while switching made one chat's pending reply lock every other chat
    // in the project. The lock itself needs no reset: it is keyed by
    // conversation, so the new chat reads its own answer.
    setSending(false);
    sawServerWorkingRef.current = false;
    // The echo belongs to the chat it was typed in, not to the page.
    setPendingUser(null);
    if (projectId !== undefined) writeLastChat(projectId, id);
  };

  const invalidateConversationsRef = useRef<() => void>(() => undefined);

  const invalidateConversations = (): void => {
    if (projectId === undefined) return;
    invalidate(`${K.conversations(projectId)}:${scope}`);
    invalidate(K.conversations(projectId));
  };
  invalidateConversationsRef.current = invalidateConversations;

  // Keep the chat list fresh without a manual refresh. The ref keeps the
  // interval stable across renders: depending on the callback itself would tear
  // the timer down and rebuild it on every keystroke in the composer.
  useEffect(() => {
    if (projectId === undefined) return;
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
  }, [projectId]);

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
  const [pendingUser, setPendingUser] = useState<{
    content: string;
    files: Message['files'];
  } | null>(null);
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
  // Keyed by project as well as conversation: ChatPage stays mounted across a
  // project switch, so a bare '__new__' slot was shared by every project and
  // text typed in one project's new chat surfaced in another's.
  const draftKey = `${projectId ?? '_'}:${activeConvId ?? '__new__'}`;
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
  const onLive = useCallback((event: LiveEvent): void => {
    setLiveSegments(prev => reduceLive(prev, event));
  }, []);

  useConversationSSE(activeConvId, onLive);

  // Switching chats must not carry one conversation's preview into another.
  useEffect(() => {
    setLiveSegments([]);
  }, [activeConvId]);

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
  const { ids: liveIds, tools: liveTools } = useLiveChats();

  /**
   * Chats whose run is paused on an approval.
   *
   * Reads the PROJECT's runs feed, not the open chat's: this marks every chat
   * in the rail, including the ones you are not looking at. An approval belongs
   * to a RUN, and the run is what knows which conversation dispatched it; there
   * is no way to ask a conversation directly.
   */
  const { data: runFeed } = useEntity<{ runs: Run[] }>(
    projectId === undefined ? 'noop:no-project-runs' : K.runs(projectId),
    () =>
      projectId === undefined
        ? Promise.resolve({ runs: [] })
        : skill.listRuns({ codebaseId: projectId, limit: skill.RUN_LIMIT })
  );
  const awaitingIds = useMemo(() => awaitingInputIds(runFeed?.runs ?? []), [runFeed?.runs]);

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

  /** Finished chats, read off the same rows the rail draws. */
  const doneIds = useMemo(() => completedIds(conversations ?? []), [conversations]);
  const readySet = useMemo(() => readyIds(conversations ?? []), [conversations]);

  /**
   * Chats with unseen activity, off the same rows.
   *
   * The chat on screen is included rather than excluded. Being open is not the
   * same as having been read — that is the whole point of clearing the mark at
   * the BOTTOM of the stream — so exempting it here would make this header
   * disagree with the rail row beside it.
   */
  const unread = useMemo(() => unreadIds(conversations ?? []), [conversations]);

  // The tab title and the opt-in notification, read off every chat in the rail
  // by the rail's own rules. Clicking a notification opens its chat here.
  const railStatuses = useMemo(
    () => chatStatuses(conversations ?? [], railLiveIds, awaitingIds),
    [conversations, railLiveIds, awaitingIds]
  );
  const railTitles = useMemo(
    () => new Map((conversations ?? []).map(c => [c.id, c.title] as const)),
    [conversations]
  );
  useTabSignal(railStatuses, railTitles, selectConversation);

  /** The status of the chat being READ. Same six states and same ordering as
   * every row in the rail — `chatStatus` owns the precedence. */
  const status: ChatStatus =
    activeConvId === null
      ? 'idle'
      : chatStatus(activeConvId, {
          working: railLiveIds,
          awaiting: awaitingIds,
          unread,
          done: doneIds,
          ready: readySet,
        });

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

  /**
   * Clear the unread mark once the reader actually reaches the bottom.
   *
   * Opening a chat is not reading it — a long reply you land on top of is the
   * exact case the mark exists for — so the trigger is `atBottom`, not mount.
   *
   * `working` gates it because a turn still streaming has not been read yet, by
   * anyone: its last line does not exist. That also matches the rail, where
   * working outranks unread.
   *
   * `visible` gates it too: a hidden tab has not been read, even with the
   * chat open at its bottom. Marking it anyway would clear the unread mark the
   * tab title counts, so a turn that ends while you are away would leave no
   * trace for you to come back to. Returning to the tab re-runs this.
   *
   * The ref keys on the ACTIVITY TIMESTAMP, not just the chat, and is what
   * stops this being a write per render. `unread` is derived from a polled
   * feed, so it stays true for a beat after the POST lands; without the key
   * every one of those renders would fire another. A new reply moves the
   * timestamp, which is exactly when a second write is wanted.
   */
  const visible = usePageVisible();
  const markedReadRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeConvId === null || lastActivityAt === null) return;
    if (!atBottom || working || !visible) return;
    if (!unread.has(activeConvId)) return;
    const key = `${activeConvId}|${lastActivityAt}`;
    if (markedReadRef.current === key) return;
    markedReadRef.current = key;
    void skill
      .markConversationRead(activeConvId)
      .then(() => {
        invalidateConversationsRef.current();
      })
      .catch(() => {
        // Let the next scroll to the bottom try again. Nothing is shown: an
        // unread mark that failed to clear is a stale dot, not a lost message,
        // and an error banner over a cosmetic write would be the louder bug.
        markedReadRef.current = null;
      });
  }, [activeConvId, lastActivityAt, atBottom, working, unread, visible]);

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
          await skill.sendMessage(activeConvId, text, files);
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

  if (projectId === undefined) {
    return <EmptyState title="No project selected." />;
  }

  const messageList = messages ?? [];
  const activeConversation = (conversations ?? []).find(c => c.id === activeConvId);
  // Which chat's summary is open, and whether it opened straight into the
  // editor. Keyed by conversation id rather than a boolean: the rail can open
  // the summary of a chat that is not the one being read.

  // Surface a failed (re)load of the conversation list or message history — a
  // revalidation can fail silently (network blip, server restart) and otherwise
  // leave stale/empty data with no signal. Send errors take precedence.
  const loadError = messagesError ?? conversationsError;

  // Current activity for the working indicator: the latest tool the agent
  // invoked in the in-flight turn (walk back to the last user message).
  // What actually renders: the persisted rows, followed by the streamed text
  // the database has not caught up with. Each preview disappears the moment its
  // real row lands, because `pendingSegments` slices by how many rows this turn
  // already has — no content comparison, and nothing to de-duplicate.
  const renderedMessages = useMemo<Message[]>(() => {
    const now = new Date().toISOString();
    // The user's echo sits after the stored rows and before any streamed reply,
    // which is the order it happened in.
    const withEcho =
      pendingUser === null
        ? messageList
        : [
            ...messageList,
            {
              id: 'pending-user',
              role: 'user' as const,
              content: pendingUser.content,
              timestamp: now,
              toolCalls: [],
              files: pendingUser.files,
              error: null,
              category: null,
              dispatch: null,
              workflowResult: null,
              usage: null,
            },
          ];
    // Deliberately measured against `messageList`, not `withEcho`: the slice is
    // by how many *stored* rows this turn has, and the echo is not one.
    const pending = pendingSegments(liveSegments, messageList);
    if (pending.length === 0) return withEcho;
    return [
      ...withEcho,
      ...pending.map(
        (seg, i): Message => ({
          id: `live-${String(i)}`,
          role: 'assistant',
          content: seg.content,
          timestamp: now,
          toolCalls: [],
          files: [],
          error: null,
          category: seg.category,
          dispatch: null,
          workflowResult: null,
          usage: null,
        })
      ),
    ];
  }, [messageList, liveSegments, pendingUser]);

  // Cheap enough to derive per render; the composer re-renders with the page anyway.
  const sent = sentHistory(renderedMessages);

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

  return (
    <section className="flex h-full min-h-0 flex-row">
      <ConversationRail
        // Remounted per project: the filter text, the selection and any open
        // menu all name chats in the project being left.
        key={projectId}
        conversations={conversations ?? []}
        omitted={
          conversationList === undefined
            ? 0
            : conversationList.total - conversationList.chats.length
        }
        openCount={counts.open}
        liveIds={railLiveIds}
        awaitingIds={awaitingIds}
        activeConvId={activeConvId}
        onSelect={selectConversation}
        onRename={renameConversation}
        onComplete={completeConversation}
        onReorder={reorderConversations}
        scope={scope}
        onScopeChange={setScope}
        doneCount={counts.done}
        pendingNew={startingNew && activeConvId === null}
        projectId={projectId}
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
              {renderedMessages.length === 0 && !working ? (
                <EmptyState
                  title={activeConvId === null ? 'New chat.' : 'No messages yet.'}
                  hint="Ask the agent about this project, or tell it what to run."
                />
              ) : (
                <StreamContextProvider
                  value={{ runStartedAt: null, assistant: activeConversation?.assistant ?? null }}
                >
                  <ChatStream
                    messages={renderedMessages}
                    onAnswer={working ? undefined : answerAsk}
                  />
                  {/* Rendered in every state, including idle. A strip that only
                      appears while working cannot be trusted to be absent for
                      the right reason — and an empty screen is exactly what a
                      broken indicator looks like. */}
                  {activeConvId !== null || working ? (
                    <ChatStatusStrip
                      status={status}
                      since={workingSince}
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
                      trailing={<ContextBar messages={renderedMessages} />}
                    />
                  ) : null}
                  <QueuedMessages
                    messages={turn.queued}
                    busyIds={turn.busyIds}
                    onEdit={turn.edit}
                    onRemove={turn.remove}
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

        {activeConvDbId !== null ? (
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
          controlRef={turn.controlRef}
          draftKey={draftKey}
          history={sent}
          projectId={projectId}
        />
      </div>
    </section>
  );
}
