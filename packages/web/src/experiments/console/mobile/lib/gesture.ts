import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Touch gestures for the mobile shell, read from raw touch events so a
 * vertical scroll keeps working everywhere a gesture is also listened for.
 */

export type Swipe = 'left' | 'right' | 'up' | 'down';

/** How far a finger travels before a movement counts as a swipe. */
export const SWIPE_PX = 60;
/** A touch that starts this close to the left edge is an edge swipe. */
export const EDGE_PX = 24;
/** How long a still finger holds before it is a long-press. */
export const LONG_PRESS_MS = 500;
/** Movement a held finger may make and still be holding still. */
const STILL_PX = 10;
/** How far the transcript must be pulled down to refresh. */
export const PULL_PX = 72;

/**
 * The swipe a finger made, or null. One axis must clearly dominate — a
 * diagonal drag is a scroll that wandered, not a gesture.
 */
export function swipeOf(dx: number, dy: number, min: number = SWIPE_PX): Swipe | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= min && ax >= ay * 1.5) return dx > 0 ? 'right' : 'left';
  if (ay >= min && ay >= ax * 1.5) return dy > 0 ? 'down' : 'up';
  return null;
}

interface Start {
  x: number;
  y: number;
  target: EventTarget | null;
}

function firstTouch(e: TouchEvent): { x: number; y: number } | null {
  const t = e.touches[0] ?? e.changedTouches[0];
  return t === undefined ? null : { x: t.clientX, y: t.clientY };
}

/**
 * Call `onSwipe` when a single finger swipes across `ref`'s element. Given the
 * touch's starting point and target, so a caller can tell an edge swipe or a
 * swipe on one message from any other.
 */
export function useSwipe(
  ref: RefObject<HTMLElement | null>,
  onSwipe: (swipe: Swipe, start: Start) => void
): void {
  const handler = useRef(onSwipe);
  handler.current = onSwipe;
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    let start: Start | null = null;
    const down = (e: TouchEvent): void => {
      const p = e.touches.length === 1 ? firstTouch(e) : null;
      start = p === null ? null : { ...p, target: e.target };
    };
    const up = (e: TouchEvent): void => {
      const p = firstTouch(e);
      if (start === null || p === null) return;
      const swipe = swipeOf(p.x - start.x, p.y - start.y);
      if (swipe !== null) handler.current(swipe, start);
      start = null;
    };
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchend', up, { passive: true });
    return (): void => {
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchend', up);
    };
  }, [ref]);
}

/**
 * Call `onHold` with the touched element when a finger rests on `ref`'s
 * element for LONG_PRESS_MS without moving — for the presses `claims` takes.
 * On those the browser's own context menu is suppressed, since this one
 * replaces it; every other press (an image's save menu) keeps the browser's.
 */
export function useLongPress(
  ref: RefObject<HTMLElement | null>,
  claims: (target: EventTarget | null) => boolean,
  onHold: (target: EventTarget | null) => void
): void {
  const handler = useRef(onHold);
  handler.current = onHold;
  const claimsRef = useRef(claims);
  claimsRef.current = claims;
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let origin: { x: number; y: number } | null = null;
    const cancel = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const down = (e: TouchEvent): void => {
      cancel();
      if (e.touches.length !== 1 || !claimsRef.current(e.target)) return;
      origin = firstTouch(e);
      const target = e.target;
      timer = setTimeout(() => {
        timer = null;
        handler.current(target);
      }, LONG_PRESS_MS);
    };
    const move = (e: TouchEvent): void => {
      const p = firstTouch(e);
      if (origin === null || p === null) return;
      if (Math.hypot(p.x - origin.x, p.y - origin.y) > STILL_PX) cancel();
    };
    const menu = (e: Event): void => {
      if (claimsRef.current(e.target)) e.preventDefault();
    };
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', cancel, { passive: true });
    el.addEventListener('touchcancel', cancel, { passive: true });
    el.addEventListener('contextmenu', menu);
    return (): void => {
      cancel();
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', cancel);
      el.removeEventListener('touchcancel', cancel);
      el.removeEventListener('contextmenu', menu);
    };
  }, [ref]);
}

/**
 * Pull-to-refresh on a scroller: how far it is being pulled down from the top
 * right now (for the indicator), and `onRefresh` when a pull past PULL_PX is
 * let go.
 */
export function usePullToRefresh(
  ref: RefObject<HTMLElement | null>,
  onRefresh: () => void
): number {
  const [pull, setPull] = useState(0);
  const handler = useRef(onRefresh);
  handler.current = onRefresh;
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    let startY: number | null = null;
    let distance = 0;
    const down = (e: TouchEvent): void => {
      const p = e.touches.length === 1 ? firstTouch(e) : null;
      startY = p !== null && el.scrollTop <= 0 ? p.y : null;
      distance = 0;
    };
    const move = (e: TouchEvent): void => {
      const p = firstTouch(e);
      if (startY === null || p === null) return;
      distance = Math.max(0, Math.min(p.y - startY, PULL_PX * 1.5));
      setPull(distance);
    };
    const up = (): void => {
      if (startY !== null && distance >= PULL_PX) handler.current();
      startY = null;
      distance = 0;
      setPull(0);
    };
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', up, { passive: true });
    el.addEventListener('touchcancel', up, { passive: true });
    return (): void => {
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', up);
      el.removeEventListener('touchcancel', up);
    };
  }, [ref]);
  return pull;
}
