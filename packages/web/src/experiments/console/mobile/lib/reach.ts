import { useSyncExternalStore } from 'react';
import { HttpError } from '../../lib/http';

/**
 * Whether the shell can talk to Archon right now.
 *
 * - `offline` — the phone itself says it has no network.
 * - `unreachable` — the phone has a network, but the chat list, the read every
 *   screen depends on, got no answer from Archon: the tailnet or VPN is down,
 *   or the server is.
 */
export type Reach = 'online' | 'offline' | 'unreachable';

/**
 * A proxy in front of Archon answering for it — Tailscale Serve, a reverse
 * proxy — because Archon itself did not.
 */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Reach from the phone's network flag and the chat list's last read.
 *
 * Any other HTTP status came from Archon, so it is reachable and the screen
 * showing that read reports the error itself. A read that threw without a
 * status never got an answer at all.
 */
export function reachOf(onLine: boolean, listError: Error | undefined): Reach {
  if (!onLine) return 'offline';
  if (listError === undefined) return 'online';
  if (listError instanceof HttpError && !GATEWAY_STATUSES.has(listError.status)) return 'online';
  return 'unreachable';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return (): void => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

function snapshot(): boolean {
  return navigator.onLine;
}

/** The phone's own network flag, kept current. */
export function useOnLine(): boolean {
  return useSyncExternalStore(subscribe, snapshot);
}
