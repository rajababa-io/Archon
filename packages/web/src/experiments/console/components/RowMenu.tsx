import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Gap between the anchor row and the menu, and the margin kept off each viewport edge. */
const GAP = 4;
const MARGIN = 8;

interface Anchor {
  top: number;
  left: number;
}

/**
 * The geometry every row in a menu shares.
 *
 * Stated once because the tick gutter only works if it is the same width on
 * every row — a checkable item and a plain one with different indents is two
 * left edges, and the eye reads that as two lists.
 */
const MENU_ROW_SHAPE =
  'flex h-[1.875rem] w-full items-center gap-2 rounded-[5px] px-2 text-left text-body';
const MENU_ROW_CLASS = `${MENU_ROW_SHAPE} hover:bg-surface-elevated`;

/** The tick gutter, reserved on every row and filled only by a checked one. */
function TickSlot({ on }: { on: boolean }): ReactElement {
  return (
    <span
      aria-hidden
      className={`w-[11px] shrink-0 text-body leading-none${on ? '' : ' opacity-0'}`}
      style={{ color: 'var(--text-primary)' }}
    >
      ✓
    </span>
  );
}

/**
 * A menu row that DOES something: rename, delete, open elsewhere.
 *
 * Carries the empty tick gutter so its label starts where a checkable row's
 * label starts.
 */
export function MenuItem({
  label,
  onSelect,
  danger = false,
  disabled = false,
}: {
  label: string;
  onSelect: () => void;
  /** Destructive: red, and kept last behind a separator by the caller. */
  danger?: boolean;
  /**
   * Set when the action is unavailable right now. The row stays in place and
   * greys out: a row that vanished would move every row below it.
   */
  disabled?: boolean;
}): ReactElement {
  if (disabled) {
    return (
      <button
        type="button"
        role="menuitem"
        aria-disabled
        onClick={e => {
          e.stopPropagation();
        }}
        className={`${MENU_ROW_SHAPE} cursor-default text-text-tertiary`}
      >
        <TickSlot on={false} />
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      onClick={e => {
        // The menu portals to the body but React still bubbles through the
        // portal to the row that owns it; a click here must not also open it.
        e.stopPropagation();
        onSelect();
      }}
      className={`${MENU_ROW_CLASS} ${danger ? 'text-error hover:bg-error/10' : 'text-text-primary'}`}
    >
      <TickSlot on={false} />
      {label}
    </button>
  );
}

/**
 * A menu row that IS a state: the label names the state, the tick says whether
 * it holds, and clicking toggles it.
 *
 * Deliberately not a verb that swaps with the state ("Mark done" / "Reopen").
 * A row whose word changes under you cannot be found by position — you read it
 * every time — and a menu of verbs shows nothing about what the thing already
 * is. Nor is it a pair of rows with the inapplicable one greyed: disabled means
 * "unavailable right now, for a reason you could fix", and the reason that row
 * is dead is that its twin is the answer, which is never fixable.
 *
 * `menuitemcheckbox` is the role that says all of this to a screen reader, so
 * the tick is not the only place the state is written down.
 *
 * The tick is NEUTRAL, not green. Green in this console means a chat's work
 * landed; a tick that was also green would make the colour mean "checked" as
 * well, and the rail's green dot is weaker for every extra thing it says.
 *
 * `checkedAction` names the click on a TICKED row only — "Reopen" beside a
 * ticked `Closed`. Unticked, the click is already obvious: the label is the
 * verb `Close`, and "Close · Mark closed" would say the same word twice. A column where half the entries carry no information is one you learn
 * to stop reading, including the half that mattered. It is `aria-hidden`
 * because the role and `aria-checked` already say that activating this clears
 * the state; as an accessible name, "Closed Reopen" is worse than nothing.
 */
export function MenuCheckItem({
  label,
  checked,
  checkedAction,
  onSelect,
}: {
  label: string;
  checked: boolean;
  checkedAction?: string;
  onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={e => {
        e.stopPropagation();
        onSelect();
      }}
      className={`${MENU_ROW_CLASS} text-text-primary`}
    >
      <TickSlot on={checked} />
      {label}
      {checked && checkedAction !== undefined ? (
        <span aria-hidden className="ml-auto whitespace-nowrap text-small text-text-tertiary">
          {checkedAction}
        </span>
      ) : null}
    </button>
  );
}

/** The rule between groups of items. */
export function MenuSeparator(): ReactElement {
  return <div role="separator" className="mx-1.5 my-1 h-px bg-border" />;
}

export interface RowMenuProps {
  /**
   * The row the menu belongs to; its rect is what the menu is placed against.
   * The element itself rather than a ref, so the value is stable across renders
   * — a fresh `{current}` object each render would re-run the placement effect
   * that sets state, and that is a render loop.
   */
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  width: number;
  children: ReactNode;
  label?: string;
}

/**
 * A row's action menu, rendered outside the list that owns the row.
 *
 * A rail row clips its own contents — `.rail-row` pins its height to its icon,
 * so anything taller is cut — and the list around it scrolls, which clips
 * again. An absolutely-positioned menu inside the row loses to both: it opened
 * correctly and was then sliced to a sliver, which is what made Archive
 * unreachable from the chat rail.
 *
 * So the menu leaves the tree it belongs to. It portals to the body, positions
 * itself against the row's live rect, and flips above the row when there is no
 * room below — the same shape WorkflowPicker's panel already uses. `console-root`
 * travels with it because the console's palette is scoped to that class; without
 * it the menu renders in the production app's colours.
 */
export function RowMenu({
  anchor: row,
  open,
  onClose,
  width,
  children,
  label,
}: RowMenuProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<Anchor | null>(null);

  // Measured from the rendered panel rather than guessed: the menu is placed
  // after it exists, which is why it renders hidden until there is a position.
  const place = useCallback((): void => {
    if (row === null) return;
    const rect = row.getBoundingClientRect();
    const height = panelRef.current?.offsetHeight ?? 0;
    const below = window.innerHeight - rect.bottom - MARGIN;
    const flip = height > below && rect.top - MARGIN > below;
    setAt({
      top: flip ? Math.max(MARGIN, rect.top - GAP - height) : rect.bottom + GAP,
      // Right-aligned to the row, then pulled back on-screen rather than
      // allowed to run off the edge of a narrow window.
      left: Math.min(
        Math.max(MARGIN, rect.right - width),
        Math.max(MARGIN, window.innerWidth - MARGIN - width)
      ),
    });
  }, [row, width]);

  useLayoutEffect(() => {
    if (!open) {
      setAt(null);
      return;
    }
    place();
    // Capture, so a scroll of the *list* repositions it, not only the window.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return (): void => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t !== null && panelRef.current?.contains(t) === true) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return (): void => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      className="console-root fixed z-[1000] rounded-lg border p-1 shadow-[0_4px_24px_-4px_rgba(0,0,0,0.28)]"
      style={{
        top: at?.top ?? 0,
        left: at?.left ?? 0,
        width,
        // Hidden for the one frame between mounting and being measured, so the
        // menu is never seen at the wrong place.
        visibility: at === null ? 'hidden' : 'visible',
        borderColor: 'var(--border-bright)',
        background: 'var(--surface-hover)',
      }}
    >
      {children}
    </div>,
    document.body
  );
}
