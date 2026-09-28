import type { ReactElement } from 'react';
import { MessagesSquare } from 'lucide-react';
import { STATUS_COLOR, STATUS_LABEL, type ChatStatus } from '../../primitives/chat-status';
import { badgeText } from '../../primitives/tab-signal';

interface ChatHeaderProps {
  /** Chats that want you, across every project. */
  needsYou: number;
  onOpenSwitcher: () => void;
  project: string | null;
  title: string | null;
  status: ChatStatus | null;
}

export function ChatHeader({
  needsYou,
  onOpenSwitcher,
  project,
  title,
  status,
}: ChatHeaderProps): ReactElement {
  return (
    <header className="mobile-safe-top flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 pb-1">
      <button
        type="button"
        onClick={onOpenSwitcher}
        aria-label={
          needsYou > 0 ? `Open chat list, ${String(needsYou)} need you` : 'Open chat list'
        }
        className="mobile-tap relative flex shrink-0 items-center justify-center text-text-secondary"
      >
        <MessagesSquare aria-hidden className="h-5 w-5" />
        {needsYou > 0 ? (
          <span
            aria-hidden
            className="absolute top-1 right-0.5 min-w-4 rounded-full px-1 text-center text-mini leading-4 font-medium text-black"
            style={{ background: 'var(--warning)' }}
          >
            {badgeText(needsYou)}
          </span>
        ) : null}
      </button>
      <div className="min-w-0 flex-1">
        {project !== null ? (
          <p className="truncate text-mini text-text-tertiary">{project} ▸</p>
        ) : null}
        <h1 className="truncate text-body font-medium text-text-primary">
          {title ?? 'Untitled chat'}
        </h1>
      </div>
      {status !== null ? (
        <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-small">
          <span aria-hidden className={`chat-status is-${status}`}>
            <i />
          </span>
          <span
            style={{ color: status === 'idle' ? 'var(--text-secondary)' : STATUS_COLOR[status] }}
          >
            {STATUS_LABEL[status]}
          </span>
        </span>
      ) : null}
    </header>
  );
}
