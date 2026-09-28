import { useEffect, useRef, useState } from 'react';

/**
 * A number that goes up each time the page comes back to the foreground after
 * being hidden, and a callback run at that moment.
 *
 * iOS suspends a backgrounded PWA's connections without closing them, so an
 * event stream can come back looking open while nothing will ever arrive on
 * it. Keying the stream subscriptions on this number tears them down and opens
 * fresh ones; `onReturn` refetches what the dead stream would have kept live,
 * because EventSource replays nothing from the gap.
 */
export function useForegroundEpoch(onReturn: () => void): number {
  const [epoch, setEpoch] = useState(0);
  const onReturnRef = useRef(onReturn);
  onReturnRef.current = onReturn;

  useEffect(() => {
    let hidden = document.visibilityState === 'hidden';
    const onChange = (): void => {
      if (document.visibilityState === 'hidden') {
        hidden = true;
        return;
      }
      if (!hidden) return;
      hidden = false;
      setEpoch(n => n + 1);
      onReturnRef.current();
    };
    document.addEventListener('visibilitychange', onChange);
    return (): void => {
      document.removeEventListener('visibilitychange', onChange);
    };
  }, []);

  return epoch;
}
