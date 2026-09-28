import { useEffect, useRef, type ReactElement } from 'react';
import { WifiOff } from 'lucide-react';
import { invalidate } from '../../store/cache';
import { K } from '../../store/keys';
import { announceReachable } from '../lib/return-epoch';
import type { Reach } from '../lib/reach';

/**
 * Says plainly when Archon cannot be reached, rather than leaving screens
 * blank, and reopens everything the moment it answers again.
 *
 * The chat list is the probe: the shell re-reads it on a timer while on
 * screen, and this re-reads it at once when the phone says it has a network
 * back, or when Try again is tapped.
 */
export function ReachBanner({ reach }: { reach: Reach }): ReactElement | null {
  const wasRef = useRef(reach);
  useEffect(() => {
    if (reach === 'online' && wasRef.current !== 'online') announceReachable();
    wasRef.current = reach;
  }, [reach]);

  useEffect(() => {
    const probe = (): void => {
      invalidate(K.allConversations);
    };
    window.addEventListener('online', probe);
    return (): void => {
      window.removeEventListener('online', probe);
    };
  }, []);

  if (reach === 'online') return null;
  return (
    <div
      role="status"
      className="mobile-banner mobile-safe-top flex items-center gap-3 border-b border-warning/50 bg-surface-elevated pr-1 pb-2 pl-4"
    >
      <WifiOff aria-hidden className="h-5 w-5 shrink-0 text-text-secondary" />
      <p className="min-w-0 flex-1 text-small text-text-primary">
        {reach === 'offline' ? (
          <>
            <strong className="font-medium">You are offline.</strong> Saved chats can be read;
            sending is off.
          </>
        ) : (
          <>
            <strong className="font-medium">Can&apos;t reach Archon at {location.host}.</strong>{' '}
            Check this phone&apos;s connection to it (Tailscale or VPN). Saved chats can be read;
            sending is off.
          </>
        )}
      </p>
      {reach === 'unreachable' ? (
        <button
          type="button"
          onClick={() => {
            invalidate(K.allConversations);
          }}
          className="mobile-tap shrink-0 rounded-lg px-3 text-small font-medium text-text-primary underline"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
