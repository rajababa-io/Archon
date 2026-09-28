import { useState, useSyncExternalStore, type ReactElement } from 'react';
import { Link } from 'react-router';

/** A phone: narrow, and driven by a finger rather than a mouse. */
const PHONE_QUERY = '(max-width: 767px) and (pointer: coarse)';
const DISMISSED_KEY = 'archon.console.mobileBannerDismissed';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return (): void => {
    query.removeEventListener('change', onChange);
  };
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    // Storage throws with cookies disabled and in some private-browsing modes.
    return false;
  }
}

/**
 * Offer the mobile shell to someone reading the console on a phone. Offered,
 * never forced: the desktop console still works at this width. Shown once —
 * following it or dismissing it retires it for good on this browser.
 */
export function MobileViewBanner(): ReactElement | null {
  const onPhone = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false
  );
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!onPhone || dismissed) return null;

  const retire = (): void => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Best-effort: it shows again next time rather than breaking this one.
    }
  };

  return (
    <div
      role="region"
      aria-label="Mobile view"
      className="flex items-center gap-2 border-b border-border bg-surface-elevated px-3 py-2 text-body"
    >
      <Link to="/m" onClick={retire} className="font-medium text-accent-bright">
        Open mobile view
      </Link>
      <span className="min-w-0 flex-1 truncate text-small text-text-tertiary">
        Built for this screen
      </span>
      <button
        type="button"
        onClick={retire}
        aria-label="Dismiss"
        className="min-h-11 min-w-11 text-text-secondary"
      >
        ✕
      </button>
    </div>
  );
}
