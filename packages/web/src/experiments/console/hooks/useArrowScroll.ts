import { useEffect, type RefObject } from 'react';
import { modalIsOpen } from '../lib/keymap';

/**
 * Pixels one arrow press moves the transcript. Close to a browser's own
 * arrow-key step for a focused scroller, so held-down repeat feels native.
 */
export const ARROW_SCROLL_PX = 64;

/** The parts of a keyboard event this decision reads. */
export interface ArrowKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

/** Element-shaped view of whatever holds focus. A plain object satisfies it. */
export interface FocusedElement {
  tagName: string;
  isContentEditable: boolean;
}

/**
 * How far an arrow press should move the transcript, or null when the key
 * belongs to something else.
 *
 * Plain ↑/↓ belong to whatever text field holds focus — in the chat composer
 * they walk your sent-message history — so they scroll only when no field is
 * focused (Escape leaves the composer). ⌥↑/⌥↓ scroll from anywhere, including
 * the composer, because the composer re-focuses itself after every send and a
 * reader should not have to leave it to look back. Selects and
 * contentEditable keep even the ⌥ form: a select opens on ⌥↓, and the summary
 * editor owns its own keys.
 */
export function arrowScrollDelta(
  event: ArrowKeyEvent,
  focused: FocusedElement | null,
  step: number = ARROW_SCROLL_PX
): number | null {
  if (event.defaultPrevented) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey) return null;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return null;

  if (focused !== null) {
    if (focused.isContentEditable) return null;
    const tag = focused.tagName.toUpperCase();
    if (tag === 'SELECT') return null;
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && !event.altKey) return null;
  }

  return event.key === 'ArrowUp' ? -step : step;
}

/**
 * Makes ↑/↓ scroll a transcript that nothing has focused.
 *
 * A scrolling `<div>` is not keyboard-focusable, and the chat composer holds
 * focus for most of a session, so without this the arrows do nothing at all on
 * the chat page. Scrolling through the element (rather than focusing it) keeps
 * the composer ready to type into, which is the state the page wants to be in.
 */
export interface UseArrowScrollOptions {
  /**
   * Called before each arrow-driven scroll. Follow-tail cannot see a key press
   * the way it sees a wheel, so the caller reports this scroll as navigation —
   * otherwise arrowing up through history would be re-pinned by the next
   * message that arrives.
   */
  onUserScroll?: () => void;
  enabled?: boolean;
}

export function useArrowScroll(
  scrollRef: RefObject<HTMLElement | null>,
  options: UseArrowScrollOptions = {}
): void {
  const { onUserScroll, enabled = true } = options;
  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent): void => {
      const el = scrollRef.current;
      if (el === null) return;
      // A dialog over the transcript owns the keyboard, same rule the keymap
      // dispatcher applies to its own bindings.
      if (modalIsOpen()) return;
      const delta = arrowScrollDelta(e, document.activeElement as HTMLElement | null);
      if (delta === null) return;
      e.preventDefault();
      onUserScroll?.();
      el.scrollBy({ top: delta });
    };

    window.addEventListener('keydown', handler);
    return (): void => {
      window.removeEventListener('keydown', handler);
    };
  }, [scrollRef, enabled, onUserScroll]);
}
