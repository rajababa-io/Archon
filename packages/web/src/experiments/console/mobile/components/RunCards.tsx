import type { ReactElement } from 'react';
import { Link } from 'react-router';
import * as skill from '../../skills';
import { useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { awaitsApproval } from '../../primitives/run';
import { ApprovalContext } from '../../components/ApprovalContext';
import { ApprovalPanel } from '../../components/ApprovalPanel';
import { runPath } from '../lib/paths';
import { RunRow } from './RunRow';

/**
 * The runs this chat started, inline under its transcript: a run stopped on a
 * gate as a full card you can approve or reject here, every other run as one
 * line. The same list and the same approval components as the desktop chat, so
 * an approval means the same thing on both.
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
          <Link to={runPath(run.id)} className="text-body font-medium text-text-primary">
            {run.workflow}
          </Link>
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
