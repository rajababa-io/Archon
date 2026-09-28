import { useEffect, useRef, useState } from 'react';

const RETURN_EVENT = 'archon-mobile-return';

/**
 * Archon answers again after it could not be reached. Every screen holding a
 * stream treats it as a return from the background: whatever was open while
 * the server was away is dead or has missed events.
 */
export function announceReachable(): void {
  window.dispatchEvent(new Event(RETURN_EVENT));
}

/**
 * A number that goes up each time the page comes back — to the foreground
 * after being hidden, or back in reach of Archon (`announceReachable`) — and
 * a callback run at that moment.
 *
 * iOS suspends a backgrounded PWA's connections without closing them, so an
 * event stream can come back looking open while nothing will ever arrive on
 * it. Keying the stream subscriptions on this number tears them down and opens
 * fresh ones; `onReturn` refetches what the dead stream would have kept live,
 * because EventSource replays nothing from the gap.
 */
export function useReturnEpoch(onReturn: () => void): number {
  const [epoch, setEpoch] = useState(0);
  const onReturnRef = useRef(onReturn);
  onReturnRef.current = onReturn;

  useEffect(() => {
    const back = (): void => {
      setEpoch(n => n + 1);
      onReturnRef.current();
    };
    let hidden = document.visibilityState === 'hidden';
    const onChange = (): void => {
      if (document.visibilityState === 'hidden') {
        hidden = true;
        return;
      }
      if (!hidden) return;
      hidden = false;
      back();
    };
    document.addEventListener('visibilitychange', onChange);
    window.addEventListener(RETURN_EVENT, back);
    return (): void => {
      document.removeEventListener('visibilitychange', onChange);
      window.removeEventListener(RETURN_EVENT, back);
    };
  }, []);

  return epoch;
}
