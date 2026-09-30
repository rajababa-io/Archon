import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { Menu } from 'lucide-react';
import { STATUS_COLOR, STATUS_LABEL, type ChatStatus } from '../../primitives/chat-status';
import { badgeText } from '../../primitives/tab-signal';
import { projectPath } from '../lib/paths';
import { useProjectIdentity } from '../../lib/project-identity';
import { ProjectMark } from './ProjectMark';

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
  // The project's colour, icon and name are how you know where you are
  // (#305): the name is drawn in the colour, and the header's bottom edge is
  // a line of it. Seeded by the id, so it is right on the first frame.
  const { color } = useProjectIdentity(projectId ?? '');
  return (
    <header
      className="mobile-safe-top flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 pb-1"
      style={{ borderBottom: projectId !== null ? `3px solid ${color}` : undefined }}
    >
      <button
        type="button"
        onClick={onOpenSwitcher}
        aria-label={
          needsYou > 0 ? `Open chat list, ${String(needsYou)} need you` : 'Open chat list'
        }
        className="mobile-tap relative flex shrink-0 items-center justify-center text-text-secondary"
      >
        <Menu aria-hidden className="h-5 w-5" />
        {needsYou > 0 ? (
          <span
            aria-hidden
            className="absolute top-1 right-0.5 min-w-4 rounded-full px-1 text-center text-mini leading-4 font-medium"
            style={{ background: 'var(--warning)', color: 'var(--surface)' }}
          >
            {badgeText(needsYou)}
          </span>
        ) : null}
      </button>
      {/* The whole title block opens the project: the project line alone is
          a caption's height, far under a finger's. */}
      {projectId !== null && project !== null ? (
        <Link
          to={projectPath(projectId)}
          className="group flex min-h-11 min-w-0 flex-1 items-center gap-2.5"
        >
          <ProjectMark projectId={projectId} size={30} />
          <span className="flex min-w-0 flex-1 flex-col justify-center">
            <span
              className="block truncate text-small font-medium underline-offset-2 group-active:underline"
              style={{ color }}
            >
              {project} ▸
            </span>
            <ChatTitle title={title} />
          </span>
        </Link>
      ) : (
        <div className="min-w-0 flex-1">
          <ChatTitle title={title} />
        </div>
      )}
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

function ChatTitle({ title }: { title: string | null }): ReactElement {
  return (
    <h1 className="truncate text-body font-medium text-text-primary">{title ?? 'Untitled chat'}</h1>
  );
}
