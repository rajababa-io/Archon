import { useEffect, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authStatusQuery } from '@/lib/auth-status';
import { SessionGate } from '@/components/auth/SessionGate';
import { MobileApp } from '@/experiments/console/mobile/MobileApp';
import { authKnownOff, rememberAuth } from '@/experiments/console/mobile/lib/auth-memory';
import { clearSavedChats } from '@/experiments/console/mobile/lib/saved-chats';

/**
 * The phone shell behind the console's session gate — except that a phone
 * which last saw web auth off opens the shell at once, without waiting on the
 * server. That is what lets it open, and read its saved chats, when Archon
 * cannot be reached. Every read the shell makes is still the server's to
 * allow, and if the answer now says auth is on, the gate takes over.
 */
export function MobileGate(): ReactElement {
  const { data } = useQuery(authStatusQuery);
  const enabled = data?.enabled;
  useEffect(() => {
    if (enabled === undefined) return;
    rememberAuth(enabled);
    if (enabled) clearSavedChats();
  }, [enabled]);

  if (enabled === false || (enabled === undefined && authKnownOff())) return <MobileApp />;
  return (
    <SessionGate>
      <MobileApp />
    </SessionGate>
  );
}
