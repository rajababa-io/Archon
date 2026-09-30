import { useEffect, useMemo, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronRight, Settings } from 'lucide-react';
import { NotificationList } from '../../components/NotificationList';
import { markAllRead } from '../../lib/use-notifications';
import { chatPath, projectPath, SETTINGS_PATH } from '../lib/paths';
import { switcherGroups } from '../lib/switcher';
import { ChatRow } from './ChatRow';
import type { MobileChats } from '../lib/use-mobile-chats';

interface ChatSwitcherProps {
  chats: MobileChats;
  /** The chat on screen, marked in the list. */
  activeId?: string;
  /** Picking a chat; the link itself navigates. */
  onPick?: () => void;
}

/**
 * What needs you on top — the same notifications list as the desktop rail's
 * bell (#289), under the same count as the header badge — then every open
 * chat, grouped by project, the ones that need you first. A project's heading
 * opens that project.
 */
export function ChatSwitcher({ chats, activeId, onPick }: ChatSwitcherProps): ReactElement {
  const { chats: all, error, reach, statuses, statusSets, projectLabel, notifications } = chats;
  const navigate = useNavigate();
  const groups = useMemo(
    () => switcherGroups(all ?? [], statuses, statusSets.unread, projectLabel),
    [all, statuses, statusSets.unread, projectLabel]
  );

  // Out of reach, the list is the saved copies, and the banner says why.
  if (reach !== 'online') {
    if (all === undefined || all.length === 0) {
      return <p className="mobile-note">No chats are saved on this phone to read offline.</p>;
    }
  } else if (error !== undefined) {
    return <p className="mobile-note text-error">Couldn&apos;t load your chats: {error.message}</p>;
  }
  if (all === undefined) return <p className="mobile-note">Loading chats…</p>;
  if (groups.length === 0) return <p className="mobile-note">No open chats.</p>;

  return (
    <div className="flex flex-col gap-4">
      {/* Beside the chat list, not in it: the rows below are every chat, and
          these are the few that want you. Offline, the saved copies carry no
          live read state worth acting on. */}
      {reach === 'online' ? (
        <NotificationList
          touch
          items={notifications}
          projectLabel={projectLabel}
          onOpen={item => {
            onPick?.();
            void navigate(chatPath(item.id));
          }}
          onMarkAllRead={() => markAllRead(notifications)}
        />
      ) : null}
      <nav aria-label="Chats" className="flex flex-col gap-4">
        {groups.map(group => (
          <section key={group.projectId} aria-label={projectLabel(group.projectId)}>
            <h2>
              <Link
                to={projectPath(group.projectId)}
                onClick={onPick}
                className="flex min-h-11 items-center gap-1 px-4 text-mini font-medium text-text-tertiary uppercase"
              >
                {projectLabel(group.projectId)}
                <ChevronRight aria-hidden className="h-3 w-3" />
              </Link>
            </h2>
            <ul>
              {group.rows.map(({ chat, status, unread }) => (
                <li key={chat.id}>
                  <ChatRow
                    chat={chat}
                    status={status}
                    unread={unread}
                    current={chat.id === activeId}
                    onPick={onPick}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    </div>
  );
}

interface SwitcherSheetProps extends ChatSwitcherProps {
  open: boolean;
  onClose: () => void;
}

/** The switcher over the chat, from the left edge, where the header button is. */
export function SwitcherSheet({ open, onClose, ...list }: SwitcherSheetProps): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 z-30 flex">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Switch chat"
        className="mobile-sheet flex w-[88%] max-w-[420px] flex-col border-r border-border bg-surface shadow-xl"
      >
        <header className="mobile-safe-top flex items-center justify-between px-4 pb-2">
          <span className="flex-1 text-large font-medium text-text-primary">Chats</span>
          <Link
            to={SETTINGS_PATH}
            onClick={onClose}
            aria-label="Settings"
            className="mobile-tap flex items-center justify-center text-text-secondary"
          >
            <Settings aria-hidden className="h-5 w-5" />
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="mobile-tap text-body text-text-secondary"
          >
            Close
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
          <ChatSwitcher {...list} onPick={onClose} />
        </div>
      </div>
      <button
        type="button"
        aria-label="Close the chat list"
        onClick={onClose}
        className="flex-1 bg-black/50"
      />
    </div>
  );
}
