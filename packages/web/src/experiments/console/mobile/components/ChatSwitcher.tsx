import { useEffect, useMemo, type ReactElement } from 'react';
import { Link } from 'react-router';
import { STATUS_LABEL } from '../../primitives/chat-status';
import { relativeTime } from '../../lib/format';
import { switcherGroups } from '../lib/switcher';
import type { MobileChats } from '../lib/use-mobile-chats';

interface ChatSwitcherProps {
  chats: MobileChats;
  /** The chat on screen, marked in the list. */
  activeId?: string;
  /** Picking a chat; the link itself navigates. */
  onPick?: () => void;
}

/** Every open chat, grouped by project, the ones that need you first. */
export function ChatSwitcher({ chats, activeId, onPick }: ChatSwitcherProps): ReactElement {
  const { chats: all, error, statuses, projectLabel } = chats;
  const groups = useMemo(
    () => switcherGroups(all ?? [], statuses, projectLabel),
    [all, statuses, projectLabel]
  );

  if (error !== undefined) {
    return <p className="mobile-note text-error">Couldn&apos;t load your chats: {error.message}</p>;
  }
  if (all === undefined) return <p className="mobile-note">Loading chats…</p>;
  if (groups.length === 0) return <p className="mobile-note">No open chats.</p>;

  return (
    <nav aria-label="Chats" className="flex flex-col gap-4">
      {groups.map(group => (
        <section key={group.projectId} aria-label={projectLabel(group.projectId)}>
          <h2 className="px-4 pb-1 text-mini font-medium text-text-tertiary uppercase">
            {projectLabel(group.projectId)}
          </h2>
          <ul>
            {group.rows.map(({ chat, status }) => (
              <li key={chat.id}>
                <Link
                  to={`/m/c/${encodeURIComponent(chat.id)}`}
                  onClick={onPick}
                  aria-current={chat.id === activeId ? 'page' : undefined}
                  className="mobile-row flex items-center gap-3 px-4 aria-[current=page]:bg-surface-hover"
                >
                  <span aria-hidden className={`chat-status is-${status} shrink-0`}>
                    <i />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-text-primary">
                      {chat.title ?? 'Untitled chat'}
                    </span>
                    <span className="block text-small text-text-tertiary">
                      {STATUS_LABEL[status]}
                      {chat.lastActivityAt !== null
                        ? ` · ${relativeTime(chat.lastActivityAt)}`
                        : ''}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
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
          <span className="text-large font-medium text-text-primary">Chats</span>
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
