import type { ReactElement } from 'react';
import { Link } from 'react-router';
import * as skill from '../../skills';
import { useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { awaitsApproval, runDetailPath, type Run } from '../../primitives/run';
import { runStatusLabel, statusDotClass } from '../../lib/run-status';
import { elapsedSince, formatElapsed, relativeTime } from '../../lib/format';
import { ApprovalContext } from '../../components/ApprovalContext';
import { ApprovalPanel } from '../../components/ApprovalPanel';

/**
 * The runs this chat started, inline under its transcript: a run stopped on a
 * gate as a full card you can approve or reject here, every other run as one
 * line. The same list and the same approval components as the desktop chat, so
 * an approval means the same thing on both.
 *
 * A row opens the desktop run detail until the mobile one exists.
 */
export function RunCards({ conversationDbId }: { conversationDbId: string }): ReactElement | null {
  const { data, error } = useEntity(K.chatRuns(conversationDbId), () =>
    skill.listChatRuns(conversationDbId)
  );
  if (error !== undefined) {
    return (
      <p className="mobile-note text-error">
        Couldn&apos;t load this chat&apos;s runs: {error.message}
      </p>
    );
  }
  const runs = data?.runs ?? [];
  if (runs.length === 0) return null;

  return (
    <section aria-label="Runs from this chat" className="flex flex-col gap-2">
      {runs.filter(awaitsApproval).map(run => (
        <article
          key={run.id}
          className="mobile-approval rounded-lg border border-warning/40 bg-warning/[0.05] p-3"
        >
          <p className="text-body font-medium text-text-primary">{run.workflow}</p>
          <ApprovalContext run={run} />
          <ApprovalPanel run={run} />
        </article>
      ))}
      {runs
        .filter(run => !awaitsApproval(run))
        .map(run => (
          <RunRow key={run.id} run={run} />
        ))}
    </section>
  );
}

function RunRow({ run }: { run: Run }): ReactElement {
  const live = run.status === 'running' || run.status === 'paused';
  return (
    <Link
      to={runDetailPath(run)}
      className="mobile-row flex items-center gap-2 rounded-lg border border-border bg-surface px-3"
    >
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass[run.status]}`} />
      <span className="min-w-0 flex-1 truncate text-body text-text-primary">{run.workflow}</span>
      <span className="shrink-0 text-small text-text-secondary">{runStatusLabel(run)}</span>
      <span className="shrink-0 text-small tabular-nums text-text-tertiary">
        {live ? formatElapsed(elapsedSince(run.startedAt)) : relativeTime(run.startedAt)}
      </span>
    </Link>
  );
}
