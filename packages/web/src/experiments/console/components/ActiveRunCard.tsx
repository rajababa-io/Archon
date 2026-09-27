import { useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { StatusStrip } from './StatusStrip';
import { LiveDot } from './LiveDot';
import { OriginBadge } from './OriginBadge';
import { ApprovalPanel } from './ApprovalPanel';
import { ApprovalContext } from './ApprovalContext';
import { runDetailPath, type Run } from '../primitives/run';
import { shortRunId, formatElapsed, elapsedSince, formatCost } from '../lib/format';
import { useIsDocker, useIdeEnv, openInIde } from '../lib/health';
import { statusTextClass, runStatusLabel, STALLED_TEXT_CLASS } from '../lib/run-status';
import { RunOutcomeBadge } from './RunOutcomeBadge';
import * as skill from '../skills';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';

/** Present + non-empty — narrows `string | null | undefined` to `string`. */
const hasValue = (v: string | null | undefined): v is string => v != null && v !== '';

interface ActiveRunCardProps {
  run: Run;
  showProject?: boolean;
  selected?: boolean;
  /**
   * True when this run's approval is currently surfaced in the pending-input
   * banner at the top of the feed. The card then shows a pointer instead of a
   * second live ApprovalPanel; dismissing the banner restores the inline panel.
   */
  inputPromoted?: boolean;
  /**
   * The row says `running` but the run has been silent far past what this
   * workflow normally takes. A judgement, not a fact from the database —
   * the caller makes it because it needs the run history. See
   * primitives/stalled.ts.
   */
  stalled?: boolean;
}

/**
 * Rich card for `running` and `paused` runs. These get attention.
 *
 * Running:
 *   - Pulsing blue live dot
 *   - Status strip pulses
 *   - Shows `node` + `tool` detail rows (mono) with a blinking cursor after
 *     the last tool name to reinforce "still working"
 *
 * Paused:
 *   - Amber pulsing dot
 *   - Inline ApprovalPanel with context input + Approve/Reject (unless the
 *     approval is promoted to the banner, in which case a pointer shows)
 *   - User can resolve without leaving the feed
 */
export function ActiveRunCard({
  run,
  showProject = false,
  selected = false,
  inputPromoted = false,
  stalled = false,
}: ActiveRunCardProps): ReactElement {
  const navigate = useNavigate();
  const isDocker = useIsDocker();
  const ideEnv = useIdeEnv();
  const elapsed = formatElapsed(elapsedSince(run.startedAt));
  const canOpen = !run.id.startsWith('demo-');
  const canOpenIde =
    !isDocker && run.workingPath !== null && run.workingPath !== '' && !run.id.startsWith('demo-');
  const showDetailGrid = run.userMessage !== '' || run.status === 'running';
  const [attentionBusy, setAttentionBusy] = useState<'resume' | 'abandon' | null>(null);
  const [attentionError, setAttentionError] = useState<string | null>(null);

  const resolveAttention = async (action: 'resume' | 'abandon'): Promise<void> => {
    setAttentionBusy(action);
    setAttentionError(null);
    try {
      if (!run.id.startsWith('demo-')) {
        if (action === 'resume') await skill.resumeRun(run.id);
        else await skill.abandonRun(run.id);
      }
      invalidate('runs');
      invalidate(K.run(run.id));
    } catch (error: unknown) {
      setAttentionError(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setAttentionBusy(null);
    }
  };

  const onCardClick = (): void => {
    if (canOpen) navigate(runDetailPath(run));
  };

  return (
    <article
      data-run-id={run.id}
      onClick={onCardClick}
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onKeyDown={
        canOpen
          ? (e): void => {
              if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                onCardClick();
              }
            }
          : undefined
      }
      className={`group relative overflow-hidden rounded-lg border transition-colors hover:bg-surface-hover ${
        run.status === 'running' ? 'bg-warning/[0.04]' : 'bg-surface'
      } ${selected ? 'ring-2 ring-accent-bright/40' : ''} ${
        canOpen ? 'cursor-pointer focus-visible:outline-none' : ''
      }`}
      // Inline because the console scope's wildcard border-color rule
      // repaints Tailwind border utilities (see theme.css). Running cards
      // get the design's amber tint.
      style={{
        borderColor: selected
          ? 'color-mix(in oklch, var(--accent-bright), transparent 30%)'
          : run.status === 'running'
            ? 'color-mix(in oklch, var(--warning), transparent 70%)'
            : 'var(--border)',
      }}
    >
      <StatusStrip status={run.status} />
      <div className="pl-3 pr-3 py-1.75">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-x-2.25 gap-y-1">
          {run.status === 'running' && !stalled ? (
            <LiveDot />
          ) : stalled ? (
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-text-tertiary" />
          ) : (
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-warning"
            />
          )}
          <span
            className={`shrink-0 text-mini font-medium ${stalled ? STALLED_TEXT_CLASS : statusTextClass[run.status]}`}
            title={
              stalled
                ? 'No activity for far longer than this workflow normally takes. The row still says running; nothing has been changed. Abandon it from the run page.'
                : undefined
            }
          >
            {runStatusLabel(run, stalled)}
          </span>
          <RunOutcomeBadge outcome={run.outcome} />
          <span className="mx-1 h-3 w-px shrink-0 bg-border" aria-hidden />
          <span className="text-large font-medium text-text-primary">{run.workflow}</span>
          <span className="text-small text-text-tertiary">{shortRunId(run.id)}</span>
          {showProject && run.projectName !== null ? (
            <span className="truncate text-small text-text-secondary">· {run.projectName}</span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <OriginBadge origin={run.origin} />
            {typeof run.costUsd === 'number' ? (
              <span
                className="text-small tabular-nums text-text-secondary"
                title="Total agent cost"
              >
                {formatCost(run.costUsd)}
              </span>
            ) : null}
            <span className="text-small tabular-nums text-text-tertiary">{elapsed}</span>
            {canOpenIde && run.workingPath !== null ? (
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  if (run.workingPath !== null) openInIde(run.workingPath, ideEnv);
                }}
                title={`Open ${run.workingPath} in IDE`}
                aria-label="Open in IDE"
                className="rounded p-1 text-text-tertiary opacity-0 transition-all hover:bg-surface-hover hover:text-text-primary group-hover:opacity-100"
              >
                <span aria-hidden className="text-body leading-none">
                  ↗
                </span>
              </button>
            ) : null}
          </div>
        </div>

        {/* Provenance + activity detail: the triggering input (when present, truncated —
            full text on hover), plus live node/tool rows while running. */}
        {showDetailGrid ? (
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-2.25 gap-y-0.5 text-body">
            {run.userMessage !== '' ? (
              <>
                <span className="text-text-tertiary">input</span>
                <span className="truncate text-text-secondary" title={run.userMessage}>
                  {run.userMessage}
                </span>
              </>
            ) : null}
            {run.status === 'running' && run.activeNodes.length > 0 ? (
              <>
                <span className="text-text-tertiary">
                  {run.activeNodes.length === 1 ? 'node' : 'nodes'}
                </span>
                <span className="text-text-primary">{run.activeNodes.join(', ')}</span>
              </>
            ) : null}
            {run.status === 'running' && hasValue(run.lastTool) ? (
              <>
                <span className="text-text-tertiary">tool</span>
                <span className="text-text-primary">
                  {run.lastTool}
                  <span aria-hidden className="ml-1 inline-block animate-pulse">
                    ▏
                  </span>
                </span>
              </>
            ) : null}
          </div>
        ) : null}

        {run.status === 'paused' && run.wait != null ? (
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-2.25 gap-y-0.5 rounded border border-warning/25 bg-warning/[0.05] px-3 py-1.25 text-body">
            <span className="text-text-tertiary">node</span>
            <span className="text-text-primary">{run.wait.nodeId}</span>
            {run.wait.kind === 'event' && run.wait.event !== undefined ? (
              <>
                <span className="text-text-tertiary">event</span>
                <span className="text-text-primary">{run.wait.event}</span>
              </>
            ) : null}
            {run.wait.kind === 'attention' ? (
              <>
                <span className="text-text-tertiary">action</span>
                <span className="text-text-secondary">{run.wait.message}</span>
                <span className="text-text-tertiary">then</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1.25">
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation();
                      void resolveAttention('resume');
                    }}
                    disabled={attentionBusy !== null}
                    className="rounded bg-warning/15 px-2 py-1 font-medium text-warning hover:bg-warning/25 disabled:opacity-50"
                  >
                    {attentionBusy === 'resume' ? 'Resuming…' : 'Resume'}
                  </button>
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation();
                      void resolveAttention('abandon');
                    }}
                    disabled={attentionBusy !== null}
                    className="rounded px-2 py-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
                  >
                    {attentionBusy === 'abandon' ? 'Abandoning…' : 'Abandon'}
                  </button>
                  {attentionError !== null ? (
                    <span className="text-error">{attentionError}</span>
                  ) : null}
                </span>
              </>
            ) : (
              <>
                <span className="text-text-tertiary">
                  {run.wait.kind === 'event' ? 'deadline' : 'resume'}
                </span>
                <span className="text-text-secondary">
                  {new Date(run.wait.resumeAt).toLocaleString()}
                </span>
              </>
            )}
          </div>
        ) : null}

        {/* Approval surface — paused only.
            The context block shows the actual question the agent asked (pulled
            from the last text event), because the approval node's own
            `message` is usually just a pointer ("answer the questions above"). */}
        {run.status === 'paused' && run.approval !== null && run.approval !== undefined ? (
          inputPromoted ? (
            <div className="mt-2 flex items-center gap-2 rounded border border-warning/25 bg-warning/[0.05] px-3 py-1.25 text-body text-warning">
              <span aria-hidden className="leading-none">
                ⚠
              </span>
              <span>Waiting for your input — see the banner at the top.</span>
            </div>
          ) : (
            <>
              <ApprovalContext run={run} />
              <ApprovalPanel run={run} />
            </>
          )
        ) : null}

        {/* Resolved gate awaiting auto-resume — the run is still 'paused' in the
            DB for the second or so between approve/reject and the executor
            flipping it to running. Show a hint instead of stale gate buttons. */}
        {run.status === 'paused' && run.gateResolved !== null && run.gateResolved !== undefined ? (
          <div className="mt-2 flex items-center gap-2 rounded border border-border bg-surface-hover/40 px-3 py-1.25 text-body text-text-secondary">
            <span aria-hidden className="inline-block animate-pulse leading-none">
              ▸
            </span>
            <span>
              {run.gateResolved === 'approved'
                ? 'Approved — resuming…'
                : 'Rejected — running on-reject rework…'}
            </span>
          </div>
        ) : null}
      </div>
    </article>
  );
}
