import { useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Run } from '../primitives/run';
import { statusDotClass, runStatusLabel } from '../lib/run-status';
import { shortRunId, relativeTime, formatElapsed, elapsedSince } from '../lib/format';
import { RunOutcomeBadge } from './RunOutcomeBadge';
import { ApprovalContext } from './ApprovalContext';
import { ApprovalPanel } from './ApprovalPanel';

interface ChatRunsPanelProps {
  /**
   * Conversation DB id of the chat being viewed — what a run's
   * `parent_conversation_id` points at, NOT the platform id the message and
   * stream routes take.
   */
  conversationDbId: string;
  projectId: string;
}

/** Rows shown before the list truncates behind "Show all". */
const COLLAPSED_ROWS = 5;
/** Server-side page size. Deep history belongs on the runs view, not the chat. */
const FETCH_LIMIT = 25;

function needsApproval(run: Run): boolean {
  return run.status === 'paused' && run.approval !== null && run.approval !== undefined;
}

/**
 * The single answer to "what has this chat started" — every run launched from
 * this conversation, in progress and finished alike, newest first, filtered
 * server-side on `parent_conversation_id`. A run with no parent conversation
 * (CLI, webhook) was started outside chat entirely and belongs to none.
 *
 * Pinned between the chat stream and the composer so it persists while messages
 * scroll. Two row shapes, each with a distinct job and no overlap between them:
 *
 *   paused on a human gate → the approval card, answerable inline (reusing
 *                            ApprovalContext + ApprovalPanel, the same
 *                            approve/reject + comment injection as everywhere
 *                            else) so a gate never forces you out of the chat.
 *                            Always shown, never truncated — it needs you.
 *   everything else        → one line each, truncated past COLLAPSED_ROWS
 *                            behind "Show all". A running run spends that line
 *                            on liveness (active nodes, elapsed); a finished
 *                            one on what it was asked to do.
 *
 * Live via the dashboard SSE, which ConsoleApp mounts at the root and which
 * invalidates the whole `runs:` key prefix — this list included.
 */
export function ChatRunsPanel({
  conversationDbId,
  projectId,
}: ChatRunsPanelProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  const { data, error } = useEntity<Awaited<ReturnType<typeof skill.listRuns>>>(
    K.chatRuns(conversationDbId),
    () => skill.listRuns({ parentConversationId: conversationDbId, limit: FETCH_LIMIT })
  );

  // Render nothing until the first load settles, rather than flashing a state
  // the response is about to contradict.
  if (data === undefined && error === undefined) return null;

  const runs = data?.runs ?? [];
  // A chat that has launched nothing says nothing: an empty strip above the
  // composer is permanent furniture that answers a question nobody asked.
  if (error === undefined && runs.length === 0) return null;

  const approvals = runs.filter(needsApproval);
  const listed = runs.filter(r => !needsApproval(r));
  const visible = expanded ? listed : listed.slice(0, COLLAPSED_ROWS);

  return (
    <div className="max-h-[55vh] shrink-0 overflow-y-auto border-t border-border bg-surface-inset/40 px-4.75 py-1.25">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-mini font-medium text-text-secondary">From this chat</span>
        {runs.length > 0 ? (
          <span className="text-small tabular-nums text-text-tertiary">
            {runs.length.toString()}
          </span>
        ) : null}
      </div>

      {error !== undefined ? (
        <p className="text-small text-error">
          Couldn&apos;t load this chat&apos;s runs: {error.message}
        </p>
      ) : (
        <>
          {approvals.map(run => (
            <ChatApprovalCard key={run.id} run={run} />
          ))}

          {visible.length > 0 ? (
            <div className="flex flex-col gap-1">
              {visible.map(run => (
                <ChatRunRow key={run.id} run={run} projectId={projectId} />
              ))}
            </div>
          ) : null}

          {listed.length > COLLAPSED_ROWS ? (
            <button
              type="button"
              onClick={() => {
                setExpanded(v => !v);
              }}
              className="mt-1 text-small text-text-tertiary transition-colors hover:text-text-primary"
            >
              {expanded ? 'Show fewer' : `Show all ${listed.length.toString()}`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Paused run awaiting approval — actionable inline via the shared components. */
function ChatApprovalCard({ run }: { run: Run }): ReactElement {
  const navigate = useNavigate();

  return (
    <article className="mb-1.5 rounded border border-warning/40 bg-warning/[0.05] p-3">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-warning" />
        <span className="shrink-0 text-mini font-medium text-warning">Waiting for approval</span>
        <RunOutcomeBadge outcome={run.outcome} />
        <span className="text-body font-medium text-text-primary">{run.workflow}</span>
        <span className="text-mini text-text-tertiary">{shortRunId(run.id)}</span>
        <button
          type="button"
          onClick={() => {
            if (run.projectId !== null) navigate(`/console/p/${run.projectId}/r/${run.id}`);
          }}
          className="ml-auto shrink-0 text-small text-text-tertiary transition-colors hover:text-text-primary"
        >
          Open logs →
        </button>
      </div>
      <ApprovalContext run={run} />
      <ApprovalPanel run={run} />
    </article>
  );
}

/**
 * One-line run row, linking to the run detail.
 *
 * The middle and trailing cells change with the run's state, because what you
 * want from a row changes with it: a run still going owes you its progress
 * (which nodes, how long), a run that has stopped owes you what it was for and
 * when it ran.
 */
function ChatRunRow({ run, projectId }: { run: Run; projectId: string }): ReactElement {
  const live = run.status === 'running' || run.status === 'paused';
  const nodes = run.activeNodes;

  return (
    <Link
      to={`/console/p/${projectId}/r/${run.id}`}
      title="Open run"
      className="flex items-center gap-2 rounded border border-border/50 bg-surface px-2.5 py-1.5 text-left transition-colors hover:border-border-bright hover:bg-surface-hover"
    >
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass[run.status]}`} />
      <span className="shrink-0 text-body font-medium text-text-primary">{run.workflow}</span>
      <span className="shrink-0 text-mini text-text-tertiary">{shortRunId(run.id)}</span>
      <span className="shrink-0 text-small text-text-secondary">{runStatusLabel(run)}</span>
      <RunOutcomeBadge outcome={run.outcome} />
      {live && nodes.length > 0 ? (
        <span className="min-w-0 flex-1 truncate text-small text-text-tertiary">
          {nodes.length === 1 ? 'node' : 'nodes'}: {nodes.join(', ')}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-body text-text-tertiary">
          {run.userMessage}
        </span>
      )}
      <span className="shrink-0 text-small tabular-nums text-text-tertiary">
        {live ? formatElapsed(elapsedSince(run.startedAt)) : relativeTime(run.startedAt)}
      </span>
    </Link>
  );
}
