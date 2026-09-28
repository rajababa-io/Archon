import { useMemo, useState, type ReactElement } from 'react';
import { useParams } from 'react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { StreamContextProvider } from '../../lib/stream-context';
import { runStatusLabel, statusDotClass, statusTextClass } from '../../lib/run-status';
import { elapsedSince, formatElapsed } from '../../lib/format';
import { useNow } from '../../lib/clock';
import { useRunDetail } from '../../hooks/useRunDetail';
import { awaitsApproval } from '@archon/awaiting';
import type { Run } from '../../primitives/run';
import { foldNodeRuns, type NodeRun, type RunEvent } from '../../primitives/event';
import type { Message } from '../../primitives/message';
import { ApprovalContext } from '../../components/ApprovalContext';
import { ApprovalPanel } from '../../components/ApprovalPanel';
import { RunStream } from '../../components/RunStream';
import { ScreenHeader } from '../components/ScreenHeader';
import { ArtifactList } from '../components/ArtifactList';
import { projectPath } from '../lib/paths';

const NODE_DOT: Record<NodeRun['status'], string> = {
  running: statusDotClass.running,
  completed: statusDotClass.completed,
  failed: statusDotClass.failed,
  skipped: statusDotClass.cancelled,
};

/**
 * `/m/r/:runId` — a run, to read and to answer. Its nodes as a vertical
 * timeline, each opening onto its own events and output; a gate as a
 * full-width answer; the files it wrote. Nothing here starts, cancels or
 * resumes a run.
 */
export function RunScreen(): ReactElement {
  const { runId = '' } = useParams<{ runId: string }>();
  const { detail, detailError, messages } = useRunDetail(runId);
  const run = detail?.run;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        back={run?.projectId != null ? projectPath(run.projectId, 'runs') : '/m'}
        backLabel={run?.projectId != null ? 'Back to runs' : 'Back to chat'}
        title={run?.workflow ?? 'Run'}
        context={run?.projectName ?? null}
        trailing={
          run !== undefined ? (
            <span className={`text-small ${statusTextClass[run.status]}`}>
              {runStatusLabel(run)}
            </span>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {detailError !== undefined ? (
          <p className="text-body text-error">Couldn&apos;t load this run: {detailError.message}</p>
        ) : detail === undefined || detail === null ? (
          <p className="text-body text-text-tertiary">Loading run…</p>
        ) : (
          <StreamContextProvider value={{ runStartedAt: detail.run.startedAt, assistant: null }}>
            <RunBody run={detail.run} events={detail.events} messages={messages ?? []} />
          </StreamContextProvider>
        )}
      </div>
    </div>
  );
}

function RunBody({
  run,
  events,
  messages,
}: {
  run: Run;
  events: RunEvent[];
  messages: Message[];
}): ReactElement {
  const nodes = useMemo(() => foldNodeRuns(events), [events]);
  return (
    <div className="flex flex-col gap-5">
      {awaitsApproval(run) ? (
        <section aria-label="Approval" className="mobile-approval">
          <ApprovalContext run={run} />
          <ApprovalPanel run={run} />
        </section>
      ) : run.gateResolved != null ? (
        <p className="text-body text-text-secondary">
          Gate {run.gateResolved}; the run resumes on its own.
        </p>
      ) : null}

      <section aria-label="Steps" className="flex flex-col">
        <h2 className="pb-1 text-mini font-medium text-text-tertiary uppercase">Steps</h2>
        {nodes.length === 0 ? (
          <p className="text-body text-text-tertiary">No step has started yet.</p>
        ) : (
          <ol className="flex flex-col">
            {nodes.map((node, i) => (
              <NodeItem
                key={node.nodeId}
                node={node}
                paused={run.status === 'paused'}
                last={i === nodes.length - 1}
                events={events}
                messages={messages}
              />
            ))}
          </ol>
        )}
      </section>

      <ArtifactList runId={run.id} />
    </div>
  );
}

function NodeItem({
  node,
  paused,
  last,
  events,
  messages,
}: {
  node: NodeRun;
  /** The run is stopped, so a step still open is waiting rather than working. */
  paused: boolean;
  last: boolean;
  events: RunEvent[];
  messages: Message[];
}): ReactElement {
  const [open, setOpen] = useState(false);
  const waiting = paused && node.status === 'running';
  const now = useNow(node.status === 'running' ? 1000 : 60_000);
  const duration =
    node.durationMs !== null
      ? formatElapsed(node.durationMs / 1000)
      : node.status === 'running'
        ? formatElapsed(elapsedSince(node.startedAt, new Date(now).toISOString()))
        : null;

  return (
    <li className="relative flex gap-3">
      {/* The rail between dots: what makes a list of steps read as one run. */}
      {!last ? (
        <span aria-hidden className="absolute top-6 bottom-0 left-[5px] w-px bg-border" />
      ) : null}
      <span
        aria-hidden
        className={`relative mt-[18px] size-[11px] shrink-0 rounded-full ${
          waiting ? statusDotClass.paused : NODE_DOT[node.status]
        }`}
      />
      <div className="min-w-0 flex-1 pb-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(v => !v);
          }}
          className="mobile-row flex w-full items-center gap-2 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body text-text-primary">{node.nodeName}</span>
            <span className="block text-small text-text-tertiary">
              {waiting ? 'waiting' : node.status}
              {node.skipReason !== null ? ` · ${node.skipReason}` : ''}
            </span>
          </span>
          {duration !== null ? (
            <span className="shrink-0 text-small tabular-nums text-text-tertiary">{duration}</span>
          ) : null}
          {open ? (
            <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
          ) : (
            <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
          )}
        </button>
        {open ? (
          <div className="min-w-0 overflow-x-auto pb-3">
            <RunStream
              messages={messages}
              events={events}
              showToolCalls
              showSystem={false}
              errorsOnly={false}
              selectedNodeId={node.nodeId}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}
