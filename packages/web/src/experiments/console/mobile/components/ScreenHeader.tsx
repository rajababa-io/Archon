import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronLeft } from 'lucide-react';

interface ScreenHeaderProps {
  /** Where Back goes. A path, not history: a screen opened from a link has no history to go back through. */
  back: string;
  backLabel: string;
  title: string;
  /** A line above the title — what the screen belongs to. */
  context?: string | null;
  /** Anything at the right end, such as a status. */
  trailing?: ReactNode;
}

/** The top of every screen that is not a chat: Back, what this is, and what it belongs to. */
export function ScreenHeader({
  back,
  backLabel,
  title,
  context,
  trailing,
}: ScreenHeaderProps): ReactElement {
  return (
    <header className="mobile-safe-top flex shrink-0 items-center gap-1 border-b border-border bg-surface px-1 pb-1">
      <Link
        to={back}
        aria-label={backLabel}
        className="mobile-tap flex shrink-0 items-center justify-center text-text-secondary"
      >
        <ChevronLeft aria-hidden className="h-5 w-5" />
      </Link>
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
