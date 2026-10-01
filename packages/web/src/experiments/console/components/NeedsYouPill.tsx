import type { ReactElement } from 'react';
import { Link } from 'react-router';

/**
 * How many things only you can clear, as one orange pill (#348). The list
 * itself lives where those things are; the Overview only counts them. Nothing
 * is drawn at zero — the best answer is an empty one, and it needs no badge.
 */
export function NeedsYouPill({ count, to }: { count: number; to: string }): ReactElement | null {
  if (count === 0) return null;
  return (
    <Link
      to={to}
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-small font-medium text-[color:var(--surface)] transition-opacity hover:opacity-90"
      style={{ background: 'var(--status-awaiting)' }}
    >
      Needs you · {count}
    </Link>
  );
}
