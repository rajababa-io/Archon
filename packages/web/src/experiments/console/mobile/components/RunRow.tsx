import type { ReactElement } from 'react';
import { Link } from 'react-router';
import type { Run } from '../../primitives/run';
import { runStatusLabel, statusDotClass } from '../../lib/run-status';
import { useNow } from '../../lib/clock';
import { runRowClock } from '../lib/run-rows';
import { runPath } from '../lib/paths';

/** One run as a line — status, workflow, and its clock — that opens the run. */
export function RunRow({ run, ciSince }: { run: Run; ciSince?: number }): ReactElement {
  const ticking = ciSince !== undefined || run.status === 'running' || run.status === 'paused';
  const now = useNow(ticking ? 1000 : 30_000);
  return (
    <Link
      to={runPath(run.id)}
      className="mobile-row flex items-center gap-2 rounded-lg border border-border bg-surface px-3"
    >
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass[run.status]}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-text-primary">{run.workflow}</span>
        <span className="block truncate text-small text-text-secondary">{runStatusLabel(run)}</span>
      </span>
      <span className="shrink-0 text-small tabular-nums text-text-tertiary">
        {runRowClock(run, ciSince, now)}
      </span>
    </Link>
  );
}
