import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronLeft } from 'lucide-react';
import { useProjectIdentity } from '../../lib/project-identity';
import { ProjectMark } from './ProjectMark';

interface ScreenHeaderProps {
  /** Where Back goes. A path, not history: a screen opened from a link has no history to go back through. */
  back: string;
  backLabel: string;
  title: string;
  /** A line above the title — what the screen belongs to. */
  context?: string | null;
  /** Anything at the right end, such as a status. */
  trailing?: ReactNode;
  /** The project this screen is, worn as its icon and a line of its colour (#305). */
  projectId?: string;
}

/** The top of every screen that is not a chat: Back, what this is, and what it belongs to. */
export function ScreenHeader({
  back,
  backLabel,
  title,
  context,
  trailing,
  projectId,
}: ScreenHeaderProps): ReactElement {
  const { color } = useProjectIdentity(projectId ?? '');
  return (
    <header
      className="mobile-safe-top flex shrink-0 items-center gap-1 border-b border-border bg-surface px-1 pb-1"
      style={projectId !== undefined ? { borderBottom: `3px solid ${color}` } : undefined}
    >
      <Link
        to={back}
        aria-label={backLabel}
        className="mobile-tap flex shrink-0 items-center justify-center text-text-secondary"
      >
        <ChevronLeft aria-hidden className="h-5 w-5" />
      </Link>
      {projectId !== undefined ? (
        <span className="mr-1.5">
          <ProjectMark projectId={projectId} size={30} />
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {context !== undefined && context !== null ? (
          <p className="truncate text-mini text-text-tertiary">{context}</p>
        ) : null}
        <h1 className="truncate text-body font-medium text-text-primary">{title}</h1>
      </div>
      {trailing !== undefined ? <div className="shrink-0 pr-2">{trailing}</div> : null}
    </header>
  );
}
