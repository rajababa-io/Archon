import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useParams } from 'react-router';
import * as skill from '../../skills';
import { invalidate, useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { conversationStreamKeys, useConversationSSE } from '../../lib/sse';
import { StreamContextProvider } from '../../lib/stream-context';
import { useFollowTail } from '../../hooks/useFollowTail';
import { useReadMarker } from '../../hooks/useReadMarker';
import { useTurnControls } from '../../hooks/useTurnControls';
import { ChatStream } from '../../components/ChatStream';
import { ChatStatusStrip } from '../../components/ChatStatusStrip';
import { QueuedMessages } from '../../components/QueuedMessages';
import { EmptyState } from '../../components/EmptyState';
import { chatStatus } from '../../primitives/chat-status';
import { baselineUserIds, echoHasLanded } from '../../primitives/pending-echo';
import { reduceLive, type LiveEvent, type LiveSegment } from '../../primitives/live-text';
import { renderedMessages, type PendingUser } from '../../primitives/rendered-messages';
import type { InlineToolCall, Message } from '../../primitives/message';
import type { ConversationSummary } from '../../primitives/conversation';
import { ChatHeader } from '../components/ChatHeader';
import { SwitcherSheet } from '../components/ChatSwitcher';
import { Composer } from '../components/Composer';
import { RunCards } from '../components/RunCards';
import { useForegroundEpoch } from '../lib/foreground';
import { writeMobileLastChat } from '../lib/last-chat';
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
            project={null}
            title="Chat not found"
            status={null}
          />
          <EmptyState
            title="This chat is not in your list."
            hint="It may have been deleted, or it belongs to another user."
          />
        </>
      ) : (
        // Keyed by chat: everything below is one chat's state, and a switch
        // must start the next chat clean rather than reset each piece by hand.
        <ChatView
          key={conversationId}
          conversationId={conversationId}
          summary={found?.chat}
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
      />
    </div>
  );
}

/**
 * The chat's own event stream, as a component so a key can replace it: see
 * `useForegroundEpoch`.
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
  project: string | null;
  chats: MobileChats;
  onOpenSwitcher: () => void;
}

function ChatView({
  conversationId,
  summary,
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

  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  const onLive = useCallback((event: LiveEvent): void => {
    setLiveSegments(prev => reduceLive(prev, event));
  }, []);
  const streamEpoch = useForegroundEpoch(() => {
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

  const onSend = (text: string): void => {
    if (working) {
      turn.queueSend(text);
      return;
    }
    setError(null);
    scrollToBottom();
    setLiveSegments([]);
    setSending(true);
    setWorkingSince(Date.now());
    pendingBaseRef.current = baselineUserIds(messages ?? []);
    setPendingUser({ content: text, files: [] });
    void (async (): Promise<void> => {
      try {
        const dispatch = await skill.sendMessage(conversationId, text);
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
  const answerAsk = useCallback((text: string): void => {
    onSendRef.current(text);
  }, []);
  const leaveAsk = useCallback((): void => {
    turn.controlRef.current?.focus();
  }, [turn.controlRef]);

  const messageList = useMemo(() => messages ?? [], [messages]);
  const rendered = useMemo(
    () => renderedMessages(messageList, pendingUser, liveSegments, new Date().toISOString()),
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

  const markDone = (): void => {
    void skill
      .setConversationCompleted(conversationId, true)
      .then(() => {
        invalidate(K.allConversations);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Could not mark the chat done.');
      });
  };

  const loadError = messagesError ?? chats.error;

  return (
    <>
      <ChatHeader
        needsYou={chats.needsYou}
        onOpenSwitcher={onOpenSwitcher}
        project={project}
        title={summary?.title ?? null}
        status={summary === undefined ? null : status}
      />
      <ConversationStream key={streamEpoch} conversationId={conversationId} onLive={onLive} />
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          {...scrollerProps}
          className="h-full overflow-y-auto overscroll-contain px-3 pt-3 pb-3"
        >
          <div ref={contentRef} className="flex flex-col gap-3">
            <StreamContextProvider
              value={{ runStartedAt: null, assistant: summary?.assistant ?? null, leaveAsk }}
            >
              {rendered.length === 0 && !working ? (
                <EmptyState title={messages === undefined ? 'Loading…' : 'No messages yet.'} />
              ) : (
                <ChatStream messages={rendered} onAnswer={working ? undefined : answerAsk} />
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
                      onClick={markDone}
                      className="mobile-tap rounded-full border border-success/50 px-3 text-small font-medium text-success"
                    >
                      Mark done
                    </button>
                  ) : undefined
                }
              />
              {summary !== undefined ? <RunCards conversationDbId={summary.dbId} /> : null}
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
      {error !== null || loadError !== undefined ? (
        <p role="alert" className="mobile-note shrink-0 border-t border-error/30 text-error">
          {error ?? `Failed to load: ${loadError?.message ?? 'unknown error'}`}
        </p>
      ) : null}
      {turn.notice !== null ? (
        <p role="status" className="mobile-note shrink-0 border-t border-border">
          {turn.notice}
        </p>
      ) : null}
      <Composer onSend={onSend} working={working} controlRef={turn.controlRef} />
    </>
  );
}
