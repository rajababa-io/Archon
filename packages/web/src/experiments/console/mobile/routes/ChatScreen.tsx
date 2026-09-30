import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from 'react';
import { useParams } from 'react-router';
import * as skill from '../../skills';
import { invalidate, useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { conversationStreamKeys, useConversationSSE } from '../../lib/sse';
import { StreamContextProvider } from '../../lib/stream-context';
import { useFollowTail } from '../../hooks/useFollowTail';
import { useReadMarker } from '../../hooks/useReadMarker';
import { useChatPresence } from '../../hooks/useChatPresence';
import { useTurnControls } from '../../hooks/useTurnControls';
import { ChatStream } from '../../components/ChatStream';
import { ChatStatusStrip } from '../../components/ChatStatusStrip';
import { QueuedMessages } from '../../components/QueuedMessages';
import { EmptyState } from '../../components/EmptyState';
import { chatStatus } from '../../primitives/chat-status';
import { baselineUserIds, echoHasLanded } from '../../primitives/pending-echo';
import { reduceLive, type LiveEvent, type LiveSegment } from '../../primitives/live-text';
import {
  renderedMessages,
  withoutThinking,
  type PendingUser,
} from '../../primitives/rendered-messages';
import type { InlineToolCall, Message } from '../../primitives/message';
import type { ConversationSummary } from '../../primitives/conversation';
import { sentHistory } from '../../lib/composer-history';
import { relativeTime } from '../../lib/format';
import { chatDraftKey } from '../../lib/draft-store';
import { ChatHeader } from '../components/ChatHeader';
import { SwitcherSheet } from '../components/ChatSwitcher';
import { Composer, type MobileComposerControl } from '../components/Composer';
import { ImageViewer, type ViewerImage } from '../components/ImageViewer';
import { MessageActions } from '../components/MessageActions';
import { ChatBell } from '../components/NotifyControls';
import { RunCards } from '../components/RunCards';
import type { SendMode } from '../components/SendMenu';
import { openAsk } from '../lib/ask-chips';
import { useReturnEpoch } from '../lib/return-epoch';
import { EDGE_PX, PULL_PX, useLongPress, usePullToRefresh, useSwipe } from '../lib/gesture';
import { writeMobileLastChat } from '../lib/last-chat';
import { saveChat, useSavedChats } from '../lib/saved-chats';
import { useMobileChats, type MobileChats } from '../lib/use-mobile-chats';

/**
 * The desktop chat page's timings, for the same reasons given there: how long
 * an unconfirmed send may speak for itself, and the refetch cadence (with its
 * hard cap) that surfaces a reply whose stream events were dropped.
 */
const CONFIRM_WAIT_MS = 20_000;
const ACTIVE_POLL_MS = 3000;
const MAX_WAIT_MS = 300_000;

/** `/m/c/:conversationId` — one chat, read and written. */
export function ChatScreen(): ReactElement {
  const { conversationId = '' } = useParams<{ conversationId: string }>();
  const chats = useMobileChats();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const found = chats.chats?.find(c => c.chat.id === conversationId);

  useEffect(() => {
    writeMobileLastChat(conversationId);
  }, [conversationId]);

  const openSwitcher = useCallback((): void => {
    setSwitcherOpen(true);
  }, []);
  const closeSwitcher = useCallback((): void => {
    setSwitcherOpen(false);
  }, []);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {chats.chats !== undefined && found === undefined ? (
        <>
          <ChatHeader
            needsYou={chats.needsYou}
            onOpenSwitcher={openSwitcher}
            projectId={null}
            project={null}
            title="Chat not found"
            status={null}
          />
          {chats.reach === 'online' ? (
            <EmptyState
              title="This chat is not in your list."
              hint="It may have been deleted, or it belongs to another user."
            />
          ) : (
            <EmptyState
              title="This chat is not saved on this phone."
              hint="The last chats you opened can be read offline. This one opens once Archon can be reached."
            />
          )}
        </>
      ) : (
        // Keyed by chat: everything below is one chat's state, and a switch
        // must start the next chat clean rather than reset each piece by hand.
        <ChatView
          key={conversationId}
          conversationId={conversationId}
          summary={found?.chat}
          projectId={found?.projectId ?? null}
          project={found === undefined ? null : chats.projectLabel(found.projectId)}
          chats={chats}
          onOpenSwitcher={openSwitcher}
        />
      )}
      <SwitcherSheet
        open={switcherOpen}
        onClose={closeSwitcher}
        chats={chats}
        activeId={conversationId}
        currentProjectId={found?.projectId}
      />
    </div>
  );
}

/**
 * The chat's own event stream, as a component so a key can replace it: see
 * `useReturnEpoch`.
 */
function ConversationStream({
  conversationId,
  onLive,
}: {
  conversationId: string;
  onLive: (event: LiveEvent) => void;
}): null {
  useConversationSSE(conversationId, onLive);
  return null;
}

interface ChatViewProps {
  conversationId: string;
  /** The chat's row; undefined until the chat list has loaded. */
  summary: ConversationSummary | undefined;
  /** Its project's id; null until the chat list has loaded. */
  projectId: string | null;
  project: string | null;
  chats: MobileChats;
  onOpenSwitcher: () => void;
}

/** The message a touch landed in, by the id `ChatGroup` stamps on it. */
function messageIdAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null;
}

function ChatView({
  conversationId,
  summary,
  projectId,
  project,
  chats,
  onOpenSwitcher,
}: ChatViewProps): ReactElement {
  const { data: messages, error: messagesError } = useEntity<Message[]>(
    K.messages(conversationId),
    () => skill.listMessages(conversationId)
  );
  const { data: lock } = useEntity(K.conversationLock(conversationId), () =>
    skill.getConversationLock(conversationId)
  );
  const locked = lock?.locked ?? false;
  const { data: config } = useEntity(K.config, skill.getConfig);

  const offline = chats.reach !== 'online';
  const saved = useSavedChats()?.find(c => c.found.chat.id === conversationId);
  // Only while the server is out of reach, and only when it never answered:
  // a transcript it did send, even one gone stale, is newer than the copy.
  const readingSaved = offline && messages === undefined && saved !== undefined;
  const shownMessages = readingSaved ? saved.messages : messages;

  const hasSummary = summary !== undefined;
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const labelRef = useRef(project);
  labelRef.current = project;
  useEffect(() => {
    const chat = summaryRef.current;
    if (offline || messages === undefined || chat === undefined || projectId === null) return;
    saveChat({
      found: { chat, projectId },
      projectLabel: labelRef.current ?? projectId,
      messages,
      savedAt: Date.now(),
    });
  }, [offline, messages, hasSummary, projectId]);

  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  const onLive = useCallback((event: LiveEvent): void => {
    setLiveSegments(prev => reduceLive(prev, event));
  }, []);
  const streamEpoch = useReturnEpoch(() => {
    for (const key of conversationStreamKeys(conversationId)) invalidate(key);
  });

  // This tab sent and the server has not confirmed it yet; see the desktop
  // chat page, which owns the same three-source rule.
  const [sending, setSending] = useState(false);
  const [pendingUser, setPendingUser] = useState<PendingUser | null>(null);
  const pendingBaseRef = useRef<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const serverWorking = chats.statusSets.working.has(conversationId);
  const working = sending || locked || serverWorking;
  const turn = useTurnControls(conversationId, locked);

  useEffect(() => {
    if (locked) setSending(false);
  }, [locked]);

  // A turn the server starts on its own — a queued message — begins with the
  // lock going up and no send from here. The last turn's streamed segments
  // would otherwise be previewed again under the new user row.
  const wasLockedRef = useRef(locked);
  useEffect(() => {
    if (locked && !wasLockedRef.current) setLiveSegments([]);
    wasLockedRef.current = locked;
  }, [locked]);

  useEffect(() => {
    if (!sending) return;
    const id = setTimeout(() => {
      setSending(false);
    }, CONFIRM_WAIT_MS);
    return (): void => {
      clearTimeout(id);
    };
  }, [sending]);

  useEffect(() => {
    if (pendingUser === null) return;
    if (!working || echoHasLanded(messages ?? [], pendingBaseRef.current)) setPendingUser(null);
  }, [messages, pendingUser, working]);

  // The server stopped reporting this turn: ask the lock's own authority again
  // rather than asserting it, in case the release event was never seen.
  const sawServerWorkingRef = useRef(false);
  useEffect(() => {
    if (serverWorking) {
      sawServerWorkingRef.current = true;
      return;
    }
    if (!sawServerWorkingRef.current) return;
    sawServerWorkingRef.current = false;
    invalidate(K.conversationLock(conversationId));
  }, [serverWorking, conversationId]);

  useEffect(() => {
    if (!working) return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        clearInterval(id);
        return;
      }
      invalidate(K.messages(conversationId));
    }, ACTIVE_POLL_MS);
    return (): void => {
      clearInterval(id);
    };
  }, [working, conversationId]);

  // When the clock starts: a send from here stamps it exactly; a turn started
  // elsewhere counts from the last thing the chat said.
  const lastActivityAt = summary?.lastActivityAt ?? null;
  const lastActivityRef = useRef(lastActivityAt);
  lastActivityRef.current = lastActivityAt;
  const [workingSince, setWorkingSince] = useState<number | null>(null);
  useEffect(() => {
    if (!working) {
      setWorkingSince(null);
      return;
    }
    setWorkingSince(prev => {
      if (prev !== null) return prev;
      const said = lastActivityRef.current;
      const t = said === null ? Number.NaN : Date.parse(said);
      return Number.isNaN(t) ? Date.now() : t;
    });
  }, [working]);

  useChatPresence(conversationId);
  useReadMarker({
    conversationId,
    lastActivityAt,
    working,
    unread: chats.statusSets.unread,
    onMarked: () => {
      invalidate(K.allConversations);
    },
  });

  const { scrollRef, contentRef, atBottom, scrollToBottom, scrollerProps } = useFollowTail();

  const onSend = (text: string, files: File[] | undefined, mode: SendMode | null): void => {
    if (working) {
      if (mode === 'steer') turn.steerSend(text);
      else if (mode === 'interrupt') turn.interruptSend(text, files);
      else turn.queueSend(text, files);
      return;
    }
    setError(null);
    scrollToBottom();
    setLiveSegments([]);
    setSending(true);
    setWorkingSince(Date.now());
    pendingBaseRef.current = baselineUserIds(messages ?? []);
    setPendingUser({
      content: text,
      files: (files ?? []).map(f => ({ name: f.name, mimeType: f.type, size: f.size })),
    });
    void (async (): Promise<void> => {
      try {
        const dispatch = await skill.sendMessage(conversationId, text, files);
        // Queued by the server after all: the queued bubble shows it, so the
        // echo goes, or the message would read as sent twice.
        if (dispatch.queuedId !== undefined) setPendingUser(null);
        invalidate(K.messages(conversationId));
        invalidate(K.allConversations);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Send failed.');
        setSending(false);
        setPendingUser(null);
      }
    })();
  };

  // Memoized message items compare `onAnswer`, so it must be stable.
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const answerAsk = useCallback((text: string, files?: File[]): void => {
    onSendRef.current(text, files, null);
  }, []);
  const leaveAsk = useCallback((): void => {
    turn.controlRef.current?.focus();
  }, [turn.controlRef]);

  const messageList = useMemo(() => shownMessages ?? [], [shownMessages]);
  const rendered = useMemo(
    () =>
      withoutThinking(
        renderedMessages(messageList, pendingUser, liveSegments, new Date().toISOString())
      ),
    [messageList, pendingUser, liveSegments]
  );

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
  const [showTools, setShowTools] = useState(false);

  // This chat's own unconfirmed send counts as working before the server says
  // so, exactly as its dot in the desktop rail does.
  const sets = chats.statusSets;
  const status = chatStatus(
    conversationId,
    working && !sets.working.has(conversationId)
      ? { ...sets, working: new Set([...sets.working, conversationId]) }
      : sets
  );

  const [seenCount, setSeenCount] = useState(rendered.length);
  useEffect(() => {
    if (atBottom) setSeenCount(rendered.length);
  }, [atBottom, rendered.length]);
  const hasNew = !atBottom && rendered.length > seenCount;

  const closeChat = (): void => {
    void skill
      .setConversationCompleted(conversationId, true)
      .then(() => {
        invalidate(K.allConversations);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Could not close the chat.');
      });
  };

  const loadError = messagesError ?? chats.error;

  const composerRef = useRef<MobileComposerControl | null>(null);
  const history = useMemo(() => sentHistory(messageList), [messageList]);
  const ask = useMemo(() => openAsk(messageList), [messageList]);
  // A queued message will be the next word, so the question is already answered.
  const chipsAsk = working || turn.queued.length > 0 ? null : ask;

  const contentOf = (id: string | null): string | null =>
    id === null ? null : (rendered.find(m => m.id === id)?.content.trim() ?? null);
  const quote = (id: string | null): void => {
    const text = contentOf(id);
    if (text !== null && text !== '') composerRef.current?.quote(text);
  };
  useSwipe(scrollRef, (swipe, start) => {
    if (swipe !== 'right') return;
    if (start.x <= EDGE_PX) onOpenSwitcher();
    // A code block or table scrolls sideways; dragging it is not a quote.
    else if (!(start.target instanceof Element && start.target.closest('pre, table') !== null))
      quote(messageIdAt(start.target));
  });
  const [held, setHeld] = useState<string | null>(null);
  useLongPress(
    scrollRef,
    target => messageIdAt(target) !== null && !(target instanceof HTMLImageElement),
    target => {
      setHeld(contentOf(messageIdAt(target)));
    }
  );
  const pull = usePullToRefresh(scrollRef, () => {
    for (const key of conversationStreamKeys(conversationId)) invalidate(key);
    invalidate(K.allConversations);
    if (summary !== undefined) invalidate(K.chatRuns(summary.dbId));
  });

  const [viewer, setViewer] = useState<{ images: ViewerImage[]; start: number } | null>(null);
  const openImage = (e: MouseEvent<HTMLDivElement>): void => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || messageIdAt(img) === null) return;
    // The image's own link would open it in a browser tab, leaving the app.
    e.preventDefault();
    const all = Array.from(
      e.currentTarget.querySelectorAll<HTMLImageElement>('[data-message-id] img')
    );
    setViewer({
      images: all.map(i => ({ src: i.currentSrc || i.src, alt: i.alt })),
      start: Math.max(0, all.indexOf(img)),
    });
  };

  return (
    <>
      <ChatHeader
        needsYou={chats.needsYou}
        onOpenSwitcher={onOpenSwitcher}
        projectId={projectId}
        project={project}
        title={summary?.title ?? null}
        status={summary === undefined ? null : status}
        bell={<ChatBell conversationId={conversationId} projectId={projectId} />}
      />
      <ConversationStream key={streamEpoch} conversationId={conversationId} onLive={onLive} />
      <div className="relative min-h-0 flex-1">
        {pull > 0 ? (
          <p
            aria-live="polite"
            className="absolute inset-x-0 top-0 z-10 flex items-end justify-center text-small text-text-tertiary"
            style={{ height: pull }}
          >
            {pull >= PULL_PX ? 'Release to refresh' : 'Pull to refresh'}
          </p>
        ) : null}
        <div
          ref={scrollRef}
          {...scrollerProps}
          onClickCapture={openImage}
          className="h-full overflow-x-hidden overflow-y-auto overscroll-contain px-3 pt-3 pb-3"
          style={pull > 0 ? { transform: `translateY(${String(pull)}px)` } : undefined}
        >
          <div ref={contentRef} className="flex flex-col gap-3">
            <StreamContextProvider
              value={{ runStartedAt: null, assistant: summary?.assistant ?? null, leaveAsk }}
            >
              {rendered.length === 0 && !working ? (
                <EmptyState
                  title={
                    shownMessages !== undefined
                      ? 'No messages yet.'
                      : offline
                        ? 'This chat is not saved on this phone.'
                        : 'Loading…'
                  }
                  hint={
                    shownMessages === undefined && offline
                      ? 'It opens once Archon can be reached.'
                      : undefined
                  }
                />
              ) : (
                <ChatStream
                  messages={rendered}
                  onAnswer={working || offline ? undefined : answerAsk}
                />
              )}
              <ChatStatusStrip
                status={status}
                since={workingSince}
                ciSince={chats.ciWaitingSince[conversationId] ?? null}
                ciAlarmMinutes={config?.config.chats?.ciWaitAlarmMinutes}
                lastActivityAt={lastActivityAt}
                trace={turnTrace}
                live={chats.liveTools[conversationId] ?? null}
                expanded={showTools}
                onToggle={() => {
                  setShowTools(v => !v);
                }}
                trailing={
                  status === 'ready' ? (
                    <button
                      type="button"
                      onClick={closeChat}
                      className="mobile-tap rounded-full border border-success/50 px-3 text-small font-medium text-success"
                    >
                      Close
                    </button>
                  ) : undefined
                }
              />
              {summary !== undefined && !offline ? (
                <RunCards conversationDbId={summary.dbId} />
              ) : null}
              <QueuedMessages
                messages={turn.queued}
                busyIds={turn.busyIds}
                onEdit={turn.edit}
                onRemove={turn.remove}
                steerable={turn.steerable}
                onSteer={turn.steer}
              />
            </StreamContextProvider>
          </div>
        </div>
        {!atBottom ? (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label={hasNew ? 'New messages, jump to latest' : 'Jump to latest'}
            className="mobile-tap absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface-elevated px-4 text-small text-text-primary shadow-md"
          >
            <span aria-hidden>↓</span>
            {hasNew ? 'New' : 'Latest'}
          </button>
        ) : null}
      </div>
      {offline ? (
        <p role="status" className="mobile-note shrink-0 border-t border-border">
          {readingSaved
            ? `Saved copy from ${relativeTime(new Date(saved.savedAt).toISOString())}. `
            : ''}
          Sending is off until Archon can be reached.
        </p>
      ) : error !== null || loadError !== undefined ? (
        <p role="alert" className="mobile-note shrink-0 border-t border-error/30 text-error">
          {error ?? `Failed to load: ${loadError?.message ?? 'unknown error'}`}
        </p>
      ) : null}
      {turn.notice !== null ? (
        <p role="status" className="mobile-note shrink-0 border-t border-border">
          {turn.notice}
        </p>
      ) : null}
      {summary === undefined || projectId === null ? (
        <div className="mobile-composer shrink-0 border-t border-border">
          <p className="mobile-note">Loading…</p>
        </div>
      ) : (
        <Composer
          key={chatDraftKey(projectId, conversationId)}
          conversationId={conversationId}
          projectId={projectId}
          provider={summary.assistant}
          draftKey={chatDraftKey(projectId, conversationId)}
          history={history}
          working={working}
          stopping={turn.stopping}
          steerable={turn.steerable}
          onSend={onSend}
          onInterrupt={turn.stop}
          ask={offline ? null : chipsAsk}
          offline={offline}
          controlRef={turn.controlRef}
          mobileRef={composerRef}
        />
      )}
      <MessageActions
        text={held}
        onClose={() => {
          setHeld(null);
        }}
        onQuote={text => {
          composerRef.current?.quote(text);
        }}
      />
      {viewer !== null ? (
        <ImageViewer
          images={viewer.images}
          start={viewer.start}
          onClose={() => {
            setViewer(null);
          }}
        />
      ) : null}
    </>
  );
}
