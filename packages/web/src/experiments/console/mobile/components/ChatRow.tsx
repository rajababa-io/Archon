import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { STATUS_LABEL, type ChatStatus } from '../../primitives/chat-status';
import type { ConversationSummary } from '../../primitives/conversation';
import { relativeTime } from '../../lib/format';
import { chatPath } from '../lib/paths';

interface ChatRowProps {
  chat: ConversationSummary;
  status: ChatStatus;
  /** Moved since you last read it: the title goes bold, the status is untouched (#5). */
  unread?: boolean;
  /** This is the chat on screen. */
  current?: boolean;
  onPick?: () => void;
}

/** One chat in a list: its status, its title, and when it last moved. */
export function ChatRow({
  chat,
  status,
  unread = false,
  current = false,
  onPick,
}: ChatRowProps): ReactElement {
  return (
    <Link
      to={chatPath(chat.id)}
      onClick={onPick}
      aria-current={current ? 'page' : undefined}
      className="mobile-row flex items-center gap-3 px-4 aria-[current=page]:bg-surface-hover"
    >
      <span aria-hidden className={`chat-status is-${status} shrink-0`}>
        <i />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-body text-text-primary${unread ? ' font-semibold' : ''}`}
        >
          {chat.title ?? 'Untitled chat'}
        </span>
        <span className="block text-small text-text-secondary">
          {STATUS_LABEL[status]}
          {chat.lastActivityAt !== null ? ` · ${relativeTime(chat.lastActivityAt)}` : ''}
        </span>
      </span>
    </Link>
  );
}
