import type { ReactElement } from 'react';
import { Link, Navigate } from 'react-router';
import { Settings } from 'lucide-react';
import { ChatSwitcher } from '../components/ChatSwitcher';
import { readMobileLastChat } from '../lib/last-chat';
import { chatPath, SETTINGS_PATH } from '../lib/paths';
import { useMobileChats } from '../lib/use-mobile-chats';

/**
 * `/m` — back into the chat last open here, or, when there is none (or it no
 * longer exists), the chat list to pick one from.
 */
export function HomeScreen(): ReactElement {
  const chats = useMobileChats();
  const last = readMobileLastChat();
  if (last !== null && chats.chats?.some(c => c.chat.id === last) === true) {
    return <Navigate to={chatPath(last)} replace />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="mobile-safe-top flex shrink-0 items-center border-b border-border pr-1 pl-4">
        <h1 className="flex-1 text-large font-medium text-text-primary">Chats</h1>
        <Link
          to={SETTINGS_PATH}
          aria-label="Settings"
          className="mobile-tap flex items-center justify-center text-text-secondary"
        >
          <Settings aria-hidden className="h-5 w-5" />
        </Link>
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
