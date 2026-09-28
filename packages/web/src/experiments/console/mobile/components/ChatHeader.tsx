import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { MessagesSquare } from 'lucide-react';
import { STATUS_COLOR, STATUS_LABEL, type ChatStatus } from '../../primitives/chat-status';
import { badgeText } from '../../primitives/tab-signal';
import { projectPath } from '../lib/paths';

interface ChatHeaderProps {
  /** Chats that want you, across every project. */
  needsYou: number;
  onOpenSwitcher: () => void;
  /** The chat's project, which its name links to; null until the chat list has loaded. */
  projectId: string | null;
  project: string | null;
  title: string | null;
  status: ChatStatus | null;
  /** The chat's notification bell, at the right end. */
  bell?: ReactNode;
}

export function ChatHeader({
  needsYou,
  onOpenSwitcher,
  projectId,
  project,
  title,
  status,
  bell,
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
        {projectId !== null && project !== null ? (
          <Link
            to={projectPath(projectId)}
            className="block truncate text-mini text-text-tertiary underline-offset-2 active:underline"
          >
            {project} ▸
          </Link>
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
      {bell}
    </header>
  );
}
