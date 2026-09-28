/**
 * Keep the shell exactly the size of what is visible, so the composer sits on
 * the keyboard's top edge instead of behind it.
 *
 * Two platforms, two mechanisms, one result. Android is told
 * `interactive-widget=resizes-content` (see `head.ts`), so the layout viewport
 * itself shrinks and the keyboard inset reads zero. iOS never resizes the
 * layout viewport: the keyboard covers it, and Safari scrolls the page to
 * reveal the focused field. `visualViewport` is the only thing that knows
 * either fact, so the shell reads its height and offset and pins itself to
 * them.
 */
import { useLayoutEffect, type RefObject } from 'react';

/** What the shell sizes itself to, in CSS pixels. */
export interface ViewportBox {
  /** Visible height: the whole screen, minus the keyboard when it is open. */
  height: number;
  /** How far the browser has scrolled the layout viewport to reveal a field. */
  top: number;
  /** How much of the layout viewport the keyboard covers. Zero when closed. */
  keyboardInset: number;
}

export function viewportBox(
  visual: { height: number; offsetTop: number } | null,
  innerHeight: number
): ViewportBox {
  if (visual === null) return { height: innerHeight, top: 0, keyboardInset: 0 };
  return {
    height: visual.height,
    top: visual.offsetTop,
    keyboardInset: Math.max(0, Math.round(innerHeight - visual.height - visual.offsetTop)),
  };
}

/**
 * Write `--vv-height`, `--vv-top` and `--kb-inset` onto the shell element and
 * keep them current. A layout effect, so the first paint is already the right
 * size; one write per animation frame however fast the viewport reports.
 */
export function useViewportBox(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const visual = window.visualViewport;
    let frame: number | null = null;
    const write = (): void => {
      frame = null;
      const box = viewportBox(visual, window.innerHeight);
      el.style.setProperty('--vv-height', `${String(box.height)}px`);
      el.style.setProperty('--vv-top', `${String(box.top)}px`);
      el.style.setProperty('--kb-inset', `${String(box.keyboardInset)}px`);
    };
    const schedule = (): void => {
      frame ??= requestAnimationFrame(write);
    };
    write();
    visual?.addEventListener('resize', schedule);
    visual?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    return (): void => {
      if (frame !== null) cancelAnimationFrame(frame);
      visual?.removeEventListener('resize', schedule);
      visual?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [ref]);
}
