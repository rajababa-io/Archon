import { Plus } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import {
  byArrangement,
  conversationLabel,
  type ConversationSummary,
} from '../primitives/conversation';
import { relativeTime } from '../lib/format';
import {
  askAwaitingIds,
  chatStatus,
  completedIds,
  readyIds,
  unreadIds,
  STATUS_TITLE,
} from '../primitives/chat-status';
import { MenuCheckItem, MenuItem, RowMenu } from './RowMenu';
import { clampPaneWidth, readPaneWidth, writePaneWidth, type PaneBounds } from '../lib/pane-width';

import { chooseNeighbourChat } from '../lib/last-chat';
import { NEW_CHAT_KEY_LABEL } from '../lib/new-chat-key';
import {
  applyChatOrder,
  clearChatOrder,
  dropIndexAt,
  previewShift,
  readChatOrder,
  reorder,
  rowBoxes,
  type RowBox,
} from '../lib/chat-order';

/** Shared empty set, so an absent prop does not allocate one per row per render. */
const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Bounds for the chat rail, narrower than the project rail's on both ends.
 *
 * A chat row carries a wrapped title and a line of activity under it, not a
 * name and a table of counts, so it stays readable further down than 232 —
 * and needs less than 440 to stop wrapping every title to two lines. The
 * initial value is the 236 the rail shipped at.
 */
const CHATLIST_WIDTH: PaneBounds = {
  key: 'archon.console.chatRailWidth',
  min: 200,
  max: 420,
  initial: 236,
};

/**
 * Which part of the lifecycle the rail is showing.
 *
 * Two positions and the union of them, because a chat has two states. There
 * used to be a third chip, `Archived`, over a second flag — and two flags made
 * four combinations, two of which nobody could read. Marking a chat done now
 * does the only job archiving did: take it out of the list you work from.
 */
export type ChatScope = 'open' | 'done' | 'all';

const SCOPES: readonly { value: ChatScope; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Closed' },
  { value: 'all', label: 'All' },
];

interface ConversationRailProps {
  conversations: ConversationSummary[];
  /** `null` while a new chat is pending — it exists only once the first message is sent. */
  activeConvId: string | null;
  onSelect: (id: string | null) => void;
  onRename: (id: string, title: string) => void;
  /**
   * Mark a chat's unit of work finished, or reopen it.
   *
   * `next` is the chat to open if this takes the page out of the one it is
   * reading — under `Open`, marking done removes the row. The rail names the
   * neighbour because only the rail knows the displayed order.
   */
  onComplete: (id: string, completed: boolean, next: string | null) => void;
  /**
   * Persist an arrangement: `ids` is the rail as displayed, top first.
   *
   * The rail says what it is showing and nothing more — it cannot see the
   * other scope, so it must not speak for it. The server rearranges the named
   * chats within the positions they already hold.
   */
  onReorder: (ids: string[]) => void;
  /**
   * Open a chat's summary. The card shows only that one exists and how fresh
   * it is — the text itself is too long to sit in a rail without either
   * clamping it to uselessness or making every card a different height.
   */
  /**
   * Chats the server is working on RIGHT NOW. A card carries a live dot while
   * it is in here, so you can tell from the rail that a chat you are not
   * looking at is still moving — and, just as importantly, that a still one
   * is genuinely idle rather than merely unobserved.
   */
  liveIds?: ReadonlySet<string>;
  /**
   * Chats with a run paused on an approval — your move, not the machine's.
   * Kept separate from `liveIds` because the two come from different places:
   * working is the server's conversation lock, awaiting belongs to a run.
   */
  awaitingIds?: ReadonlySet<string>;
  /** Chats the server is watching CI for, from the same health read as `liveIds`. */
  ciWaitingIds?: ReadonlySet<string>;
  /** Which lifecycle scope the list is showing; the rail does not fetch. */
  scope: ChatScope;
  onScopeChange: (scope: ChatScope) => void;
  /**
   * How many chats each scope holds, counted server-side. Not `conversations.
   * length`: that is the list currently shown, which is the wrong set for two
   * of the three tabs and a capped one for all three.
   */
  openCount: number;
  doneCount: number;
  /**
   * Chats in this scope the server did not send, because the listing is
   * capped. Drawn as a line under the last row: a list that quietly stops
   * short looks exactly like a complete one.
   */
  omitted: number;
  /** Which project's manual order to read and write. */
  projectId: string;
  /**
   * True while a new chat is pending. It has no row in the database until the
   * first message is sent, so the rail draws a placeholder — without one,
   * pressing New chat looked like it had done nothing.
   */
  pendingNew: boolean;
}

/**
 * A project's chats as a rail of cards, replacing the single-select switcher.
 *
 * Mirrors ProjectRail's language deliberately — monogram tile,
 * count pill, bordered selected row with a colored edge — so the two rails read
 * as one system rather than two components that happen to sit side by side.
 *
 * The selected card's edge takes the chat's own color rather than the brand
 * accent: a colored chat would otherwise show its color on the tile and a
 * different accent on the border, which reads as two unrelated signals.
 */
export function ConversationRail({
  conversations,
  activeConvId,
  onSelect,
  onRename,
  onComplete,
  onReorder,
  scope,
  onScopeChange,
  openCount,
  doneCount,
  omitted,
  pendingNew,
  projectId,
  liveIds,
  awaitingIds,
  ciWaitingIds,
}: ConversationRailProps): ReactElement {
  /* No filter box: a permanent text field for one project's chats was chrome.
     Finding a chat by name is the ⌘K palette's job, across every project. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Stable, because RowMenu holds it in a listener effect.
  const closeMenu = useCallback((): void => {
    setMenuFor(null);
  }, []);
  const renameRef = useRef<HTMLInputElement>(null);

  /* ── drag to resize ─────────────────────────────────────────────────────
     The project rail's gesture, on the rail beside it: pointer-driven, clamped
     to the pane's bounds, written down on release rather than on every frame.
     Two resizable panes in one row that behaved differently would be the thing
     to explain, not the second handle. */
  const [width, setWidth] = useState<number>(() => readPaneWidth(CHATLIST_WIDTH));
  const [resizing, setResizing] = useState(false);
  // The width as of this render, readable from inside the pointer listeners —
  // which are registered once per gesture and would otherwise close over the
  // width the drag STARTED at forever.
  const widthRef = useRef(width);
  widthRef.current = width;

  const startResize = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    let latest = startW;
    setResizing(true);
    const move = (ev: PointerEvent): void => {
      latest = clampPaneWidth(startW + (ev.clientX - startX), CHATLIST_WIDTH);
      setWidth(latest);
    };
    const up = (): void => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      writePaneWidth(CHATLIST_WIDTH, latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  useEffect(() => {
    // select(), not just focus(): a rename almost always replaces the title
    // rather than appending to it, so the existing text should be gone the
    // moment you type. ProjectRow has done this since it was written; the chat
    // rail only focused, which left the caret at one end and made every rename
    // a select-all first. Two renames in one app that behave differently is
    // the defect, not either behavior on its own.
    if (renamingId !== null) renameRef.current?.select();
  }, [renamingId]);

  /**
   * The arrangement just committed, held until the server's list agrees.
   *
   * The order lives on the rows, so the list has to come back before it can
   * show the new one. Without this the dropped card springs back to where it
   * was for as long as the round trip takes, which reads as a failed drag.
   */
  const [pending, setPending] = useState<string[] | null>(null);
  /** The last arrangement sent, so a re-render cannot send it twice. */
  const sentRef = useRef('');
  const [dragId, setDragId] = useState<string | null>(null);
  // Which row the cursor is over, and the row geometry as it stood when the
  // drag began. Both are needed to draw the preview; see `previewShift`.
  const [dropIndex, setDropIndex] = useState(-1);
  const boxesRef = useRef<RowBox[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  /**
   * The row whose handle is under the mouse.
   *
   * `draggable` is armed on mousedown over the monogram and disarmed the moment
   * the gesture ends, so a drag can only start from the handle. The alternative
   * — marking the handle itself draggable — drags the handle, and the card the
   * user is actually moving never leaves the list.
   */
  const [armed, setArmed] = useState<string | null>(null);

  // A press on the handle that never became a drag must not leave the row
  // draggable from anywhere on it.
  useEffect(() => {
    if (armed === null) return;
    const disarm = (): void => {
      setArmed(null);
    };
    window.addEventListener('mouseup', disarm);
    return (): void => {
      window.removeEventListener('mouseup', disarm);
    };
  }, [armed]);

  /** The list as the server has it arranged. */
  const arranged = useMemo(() => [...conversations].sort(byArrangement), [conversations]);

  const visible = useMemo(
    () => (pending === null ? arranged : applyChatOrder(arranged, pending)),
    [arranged, pending]
  );

  /**
   * Two routes to one meaning. A paused gate belongs to a RUN and arrives as a
   * prop; an unanswered question belongs to the last MESSAGE and is read off
   * the conversation itself. A reader scanning the rail does not care which —
   * both say it is your move — so they merge before the mark is drawn.
   */
  const awaiting = useMemo(() => {
    const ids = askAwaitingIds(conversations);
    for (const id of awaitingIds ?? EMPTY_SET) ids.add(id);
    return ids;
  }, [conversations, awaitingIds]);

  /** Finished chats, read off the rows the rail already has. */
  const done = useMemo(() => completedIds(conversations), [conversations]);
  const ready = useMemo(() => readyIds(conversations), [conversations]);

  /**
   * Chats that have spoken since the reader last reached the bottom of them.
   *
   * Read off the same rows, and deliberately NOT merged into `awaiting` above:
   * the two share a colour but not a rank, since a chat still streaming is
   * unfinished rather than missed. `chatStatus` owns that precedence.
   */
  const unread = useMemo(() => unreadIds(conversations), [conversations]);

  // The server has caught up; stop overriding it. Anything else — a failed
  // write — leaves the arrangement on screen and the error on the page.

  useEffect(() => {
    if (pending === null) return;
    const server = arranged.map(c => c.id);
    if (server.length === pending.length && server.every((id, i) => id === pending[i])) {
      setPending(null);
    }
  }, [arranged, pending]);

  /**
   * Give every chat on screen a position, the first time it is seen.
   *
   * A chat with no position is placed by recency, which is why a rail left
   * alone rearranged itself as replies landed and bumped `last_activity_at`.
   * Writing the position down on sight is what makes the order absolute: after
   * this pass nothing but a drag moves a row.
   *
   * This is also the one-time migration off localStorage. An arrangement made
   * before the order lived on the row is honoured if nothing here has been
   * placed yet, and the local copy is dropped once the server holds one —
   * server wins from then on, the same rule the project rail follows.
   */
  useEffect(() => {
    if (visible.length === 0) return;
    if (!visible.some(c => c.sortOrder === null)) {
      // Guarded, because this runs on every poll and only the first one has
      // anything to drop.
      if (readChatOrder(projectId).length > 0) clearChatOrder(projectId);
      return;
    }
    // Only when NOTHING is placed: a half-seeded rail would be fighting the
    // server with an order that predates it.
    const local = visible.every(c => c.sortOrder === null) ? readChatOrder(projectId) : [];
    const seed = (local.length > 0 ? applyChatOrder(visible, local) : visible).map(c => c.id);
    const key = seed.join(',');
    if (sentRef.current === key) return;
    sentRef.current = key;
    onReorder(seed);
  }, [visible, projectId, onReorder]);

  /** The gap between cards, kept in step with each row's `mb-0.5`. */
  const ROW_GAP = 2;

  const dragFrom = dragId === null ? -1 : visible.findIndex(c => c.id === dragId);

  const endDrag = (): void => {
    setDragId(null);
    setDropIndex(-1);
    setArmed(null);
    boxesRef.current = [];
  };

  const beginDrag = (id: string, index: number): void => {
    const rects = visible.map(c => {
      const el = rowRefs.current.get(c.id);
      const r = el?.getBoundingClientRect();
      return { top: r?.top ?? 0, bottom: r?.bottom ?? 0 };
    });
    boxesRef.current = rowBoxes(rects, ROW_GAP);
    scrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
    setDragId(id);
    setDropIndex(index);
  };

  const onDropHere = (): void => {
    const target = visible[dropIndex];
    if (dragId !== null && target !== undefined && target.id !== dragId) {
      const next = reorder(visible, dragId, target.id);
      // Shown immediately, sent once. Recording it as sent also stops the
      // seeding effect above from answering the same render with a second,
      // contradictory arrangement.
      setPending(next);
      sentRef.current = next.join(',');
      onReorder(next);
    }
    endDrag();
  };

  const commitRename = (id: string): void => {
    const next = draft.trim();
    const current = conversations.find(c => c.id === id);
    // An empty rename is a no-op, not a way to blank a title: a nameless row
    // cannot be told apart from any other in the list.
    if (next.length > 0 && current !== undefined && next !== conversationLabel(current)) {
      onRename(id, next);
    }
    setRenamingId(null);
  };

  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>, id: string): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename(id);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setRenamingId(null);
    }
  };

  /**
   * Opening a chat is one click, always.
   *
   * Multi-select is gone: the design's row menu acts on the chat it belongs
   * to, and the only thing selection bought was bulk filing and bulk recolor
   * — neither of which still exists. `additive` stays in the signature because
   * a modifier-click still means "not the ordinary case" and callers pass it;
   * it simply no longer builds a set.
   */
  const open = (id: string, _additive: boolean): void => {
    setMenuFor(null);
    onSelect(id);
  };

  return (
    <aside
      className="chatlist relative flex h-full min-h-0 shrink-0 flex-col"
      style={{ width, flexBasis: width }}
      aria-label="Chats"
      onClick={() => {
        setMenuFor(null);
      }}
    >
      {/* Scope first, then New chat. No header row and no filter box: the
          header repeated the count the tab above already carries, and a
          permanent filter field for a list this short was chrome. */}
      <div className="chatlist-head">
        {SCOPES.map(({ value, label }) => {
          // Counts on Open and Closed, not on All.
          //   Closed is the one you cannot see — a count answers "is there
          //   anything in there?" without a click, which is the only reason to
          //   click it. Open agrees with the list below by construction.
          //   All is not a set you are asking about; it is the absence of a
          //   filter, and its count is the sum of the two beside it.
          // Both come from the server, not from the rendered list: that list
          // is one scope's, and a capped one.
          const count = value === 'open' ? openCount : value === 'done' ? doneCount : 0;
          return (
            <button
              key={value}
              type="button"
              onClick={() => {
                onScopeChange(value);
              }}
              aria-pressed={scope === value}
              className={`rounded-[6px] px-2 py-[3px] text-mini transition-colors ${
                scope === value
                  ? 'bg-surface-hover text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {label}
              {/* Zero renders blank, as in the rail table — a Closed chip with
                  no number says "nothing finished yet" by its silence. */}
              {count > 0 ? <span className="ml-1.5 text-text-tertiary">{count}</span> : null}
            </button>
          );
        })}
      </div>

      <div className="px-2">
        <button
          type="button"
          onClick={() => {
            onSelect(null);
          }}
          // Deliberately not gated on `busy`: a reply owed to another chat
          // still lands in that chat, so waiting buys nothing and makes the
          // project feel single-threaded when it is not.
          disabled={activeConvId === null}
          title={activeConvId === null ? 'Already on a new chat' : 'Start a new chat'}
          aria-keyshortcuts="Meta+Shift+O Control+Shift+O"
          className="newchat disabled:cursor-default disabled:opacity-40"
        >
          <Plus className="h-[13px] w-[13px]" />
          New chat
          {/* Pinned right so the label stays centred; the same pill as ⌘K on
              the project rail's Search row. */}
          <span
            aria-hidden
            className="absolute right-2 rounded border px-[5px] py-px text-mini text-text-tertiary"
            style={{ borderColor: 'var(--border-bright)' }}
          >
            {NEW_CHAT_KEY_LABEL}
          </span>
        </button>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-1.25"
        // The whole list answers the drag, not each row: rows slide under the
        // cursor during the preview, so a per-row hit test would report
        // whichever row had just moved into place rather than the one the user
        // is pointing at.
        onDragOver={e => {
          if (dragId === null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const scrolledBy = (scrollRef.current?.scrollTop ?? 0) - scrollTopRef.current;
          setDropIndex(dropIndexAt(boxesRef.current, e.clientY, scrolledBy));
        }}
        onDrop={e => {
          if (dragId === null) return;
          e.preventDefault();
          onDropHere();
        }}
      >
        {pendingNew ? (
          <div
            className="mb-0.5 flex items-center gap-2 rounded-lg border px-2.5 py-1.25"
            style={{
              borderColor: 'color-mix(in oklch, var(--accent), transparent 55%)',
              background: 'var(--surface-elevated)',
            }}
          >
            <span aria-hidden className="w-3.5 shrink-0" />
            <span
              aria-hidden
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-dashed text-body font-medium text-text-tertiary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              +
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-medium text-text-primary">
                New chat
              </span>
              <span className="mt-[2px] block text-small text-text-tertiary">
                Send a message to start it
              </span>
            </span>
          </div>
        ) : null}

        {visible.length === 0 && !pendingNew ? (
          <p className="px-2 py-1.75 text-body text-text-tertiary">No chats yet.</p>
        ) : null}

        {visible.map((c, index) => {
          const isActive = c.id === activeConvId;
          const status = chatStatus(c.id, {
            working: liveIds ?? EMPTY_SET,
            awaiting,
            unread,
            done,
            ready,
            waiting: ciWaitingIds ?? EMPTY_SET,
          });
          const shift =
            dragId === null ? 0 : previewShift(boxesRef.current, dragFrom, dropIndex, index);
          return (
            <div
              key={c.id}
              ref={el => {
                if (el === null) rowRefs.current.delete(c.id);
                else rowRefs.current.set(c.id, el);
              }}
              aria-current={isActive}
              className={`rail-row group${dragId === c.id ? ' opacity-40' : ''}`}
              style={{
                // A transform, never a layout change: the geometry captured at
                // drag start has to stay true for the whole gesture.
                transform: shift === 0 ? undefined : `translateY(${String(shift)}px)`,
                transition: 'transform 150ms, opacity 150ms, background-color 110ms',
              }}
              draggable={armed === c.id && renamingId === null}
              onDragStart={e => {
                beginDrag(c.id, index);
                e.dataTransfer.effectAllowed = 'move';
                // Firefox refuses to start a drag without payload.
                e.dataTransfer.setData('text/plain', c.id);
              }}
              onDragEnd={() => {
                endDrag();
              }}
              onContextMenu={e => {
                e.preventDefault();
                setMenuFor(c.id);
              }}
            >
              {/* Six dots in the row's reserved gutter, invisible until hover
                  — the same handle the project rail uses, so reordering is one
                  gesture to learn rather than two. */}
              {renamingId !== c.id ? (
                <span
                  aria-hidden
                  title="Drag to reorder"
                  className="rail-grip-dots"
                  onMouseDown={() => {
                    setArmed(c.id);
                  }}
                >
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}

              {/* Status on the LEFT, where the eye lands first on a list you
                  scan rather than read. One mark in three states, never a
                  different KIND of mark per state: a chat bubble for idle made
                  the column read as two vocabularies — a glyph that says what
                  the row is, and dots that say what it is doing — and it was
                  also the one surface disagreeing with the chat's own status
                  pill and the project chip, which have always drawn all three
                  as dots. Idle is the quiet one: still, grey, no halo. */}
              <span aria-hidden title={STATUS_TITLE[status]} className={`chat-status is-${status}`}>
                <i />
              </span>

              {renamingId === c.id ? (
                <input
                  ref={renameRef}
                  value={draft}
                  onChange={e => {
                    setDraft(e.target.value);
                  }}
                  onKeyDown={e => {
                    onRenameKey(e, c.id);
                  }}
                  onBlur={() => {
                    commitRename(c.id);
                  }}
                  maxLength={255}
                  aria-label="Rename chat"
                  className="chat-rename"
                />
              ) : (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    open(c.id, e.metaKey || e.ctrlKey || e.shiftKey);
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  {/* Two lines: the title wraps to two rather than being
                      truncated at a width the rail never had, and the
                      timestamp sits UNDER it instead of competing for the
                      same line. */}
                  <span className="rail-text">{conversationLabel(c)}</span>
                  {/* Always the timestamp, never the state.
                      The second line used to say the state in its own colour —
                      "needs you", "editing rail.css" — and between the dot,
                      the word and the colour a row said the same thing three
                      times. Eleven rows of that is a rail you decode rather
                      than scan. The dot carries the state; this line carries
                      the one fact the dot cannot, which is how long ago.
                      The chat you have OPEN still names its tool, in the status
                      strip above the composer — one of those on screen, in the
                      place where the detail is worth the room. */}
                  {c.lastActivityAt !== null ? (
                    <time dateTime={c.lastActivityAt} className="chat-stamp">
                      {relativeTime(c.lastActivityAt)}
                    </time>
                  ) : null}
                </button>
              )}

              <RowMenu
                anchor={rowRefs.current.get(c.id) ?? null}
                open={menuFor === c.id}
                onClose={closeMenu}
                width={220}
                label={`Actions for ${conversationLabel(c)}`}
              >
                <MenuItem
                  label="Rename…"
                  onSelect={() => {
                    setDraft(conversationLabel(c));
                    setRenamingId(c.id);
                    setMenuFor(null);
                  }}
                />
                {/* Unticked, the row is the verb `Close`; ticked, it names the
                    state `Closed` and the tick says it holds. Either way it is
                    the second item — findable by position. `Reopen` appears
                    only on a ticked row, because that is the only one whose
                    click does the opposite of its label. */}
                <MenuCheckItem
                  label={c.completed ? 'Closed' : 'Close'}
                  checked={c.completed}
                  checkedAction="Reopen"
                  onSelect={() => {
                    onComplete(
                      c.id,
                      !c.completed,
                      activeConvId === c.id
                        ? chooseNeighbourChat(visible, activeConvId, [c.id])
                        : null
                    );
                    setMenuFor(null);
                  }}
                />
              </RowMenu>
            </div>
          );
        })}

        {/* The listing is capped server-side, so a long-running project's
            finished chats eventually outrun it. Say so under the last row:
            without this the list stops at the cap and looks complete. */}
        {omitted > 0 ? (
          <p className="px-2 py-1.75 text-small text-text-tertiary">
            {omitted} older {omitted === 1 ? 'chat' : 'chats'} not shown.
          </p>
        ) : null}
      </div>

      {/* Resize handle, straddling the rail's own border — the project rail's
          handle, in the same place relative to its pane, so the gesture is one
          thing to learn rather than two. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat list"
        title="Drag to resize"
        onPointerDown={startResize}
        className="group absolute -right-1 top-0 z-10 flex h-full w-[9px] cursor-col-resize items-center justify-center"
      >
        <span
          aria-hidden
          className={`w-[2px] rounded-sm transition-all ${
            resizing
              ? 'h-full bg-accent-bright'
              : 'h-9 bg-transparent group-hover:h-14 group-hover:bg-accent-bright/60'
          }`}
        />
      </div>
    </aside>
  );
}
