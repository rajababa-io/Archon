import type { ReactElement } from 'react';
import { Navigate } from 'react-router';
import { ChatSwitcher } from '../components/ChatSwitcher';
import { readMobileLastChat } from '../lib/last-chat';
import { useMobileChats } from '../lib/use-mobile-chats';

/**
 * `/m` — back into the chat last open here, or, when there is none (or it no
 * longer exists), the chat list to pick one from.
 */
export function HomeScreen(): ReactElement {
  const chats = useMobileChats();
  const last = readMobileLastChat();
  if (last !== null && chats.chats?.some(c => c.chat.id === last) === true) {
    return <Navigate to={`/m/c/${encodeURIComponent(last)}`} replace />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="mobile-safe-top shrink-0 border-b border-border px-4 pb-2">
        <h1 className="text-large font-medium text-text-primary">Chats</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3">
        {/* Nothing to redirect to until the list says whether `last` exists. */}
        {last !== null && chats.chats === undefined && chats.error === undefined ? (
          <p className="mobile-note">Opening your last chat…</p>
        ) : (
          <ChatSwitcher chats={chats} />
        )}
      </div>
    </div>
  );
}
