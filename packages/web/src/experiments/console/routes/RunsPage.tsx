import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { ActiveRunCard } from '../components/ActiveRunCard';
import { RecentRunRow } from '../components/RecentRunRow';
import { FilterChips, type Filter } from '../components/FilterChips';
import { DraftRunCard } from '../components/DraftRunCard';
import { PendingInputBanner } from '../components/PendingInputBanner';
import { useEntity } from '../store/cache';
import { K, type Scope } from '../store/keys';
import { readProjectView } from '../lib/project-view';
import { useKeymap, type Binding } from '../lib/keymap';
import * as skill from '../skills';
import { runDetailPath, type Run } from '../primitives/run';
import type { RunCounts } from '../skills/runs';
import type { Project } from '../primitives/project';
import { useNow } from '../lib/clock';
import { stalledIds } from '../primitives/stalled';

interface FeedData {
  runs: Run[];
  counts: RunCounts;
  total: number;
}

const EMPTY_COUNTS: RunCounts = {
  all: 0,
  running: 0,
  paused: 0,
  failed: 0,
  completed: 0,
  cancelled: 0,
  pending: 0,
};

/**
 * Demo runs injected when `?demo=1` is in the URL. Lets us eyeball card colors
 * in context against whatever real runs exist. Ids start with `demo-` so the
 * detail-page navigation can be made a no-op later if needed.
 */
function buildDemoRuns(scope: Scope, projectName: string | null): Run[] {
  const now = Date.now();
  const iso = (secondsAgo: number): string => new Date(now - secondsAgo * 1000).toISOString();
  const project = scope === 'all' ? 'archon-core' : scope;
  const projName = projectName ?? 'archon-core';
  const base = {
    projectId: project,
    projectName: projName,
    costUsd: null as number | null,
    conversationId: null as string | null,
    parentConversationId: null as string | null,
    conversationPlatformId: null as string | null,
    workerPlatformId: null as string | null,
    outcome: null,
    workingPath: null,
    userMessage: '',
    activeNodes: [] as string[],
    finishedAt: null as string | null,
    lastActivityAt: null,
  };
  return [
    {
      ...base,
      id: 'demo-running-1',
      workflow: 'plan',
      origin: 'cli',
      status: 'running',
      startedAt: iso(4 * 60 + 12),
      activeNodes: ['plan/draft'],
      currentNode: 'plan/draft',
      lastTool: 'read_file',
    },
    {
      ...base,
      id: 'demo-running-2',
      workflow: 'implement',
      origin: 'web',
      status: 'running',
      startedAt: iso(9 * 60 + 38),
      activeNodes: ['implement/loop'],
      currentNode: 'implement/loop',
      lastTool: 'edit_file',
    },
    {
      ...base,
      id: 'demo-paused-1',
      workflow: 'archon-interactive-prd',
      origin: 'web',
      status: 'paused',
      startedAt: iso(14 * 60 + 22),
      currentNode: 'foundation-gate',
      lastTool: null,
      approval: {
        nodeId: 'foundation-gate',
        message:
          'Answer the foundation questions above. Your answers will guide the research phase.',
        completionSignaled: false,
        decisions: [{ id: 'approve' }, { id: 'reject' }],
        decisionsAuthored: false,
      },
    },
    {
      ...base,
      id: 'demo-paused-2',
      workflow: 'review',
      origin: 'slack',
      status: 'paused',
      outcome: 'succeeded',
      startedAt: iso(4 * 60 + 2),
      currentNode: 'review/approve',
      lastTool: null,
      approval: {
        nodeId: 'review/approve',
        message: 'Approve changes before opening PR?',
        completionSignaled: false,
        decisions: [{ id: 'approve' }, { id: 'reject' }],
        decisionsAuthored: false,
      },
    },
    {
      ...base,
      id: 'demo-failed-1',
      workflow: 'test',
      origin: 'github',
      status: 'failed',
      startedAt: iso(2 * 60 + 41),
      finishedAt: iso(0),
      lastActivityAt: null,
      currentNode: 'implement/verify',
      lastTool: null,
    },
    {
      ...base,
      id: 'demo-completed-1',
      workflow: 'assist',
      origin: 'telegram',
      status: 'completed',
      outcome: 'failed',
      startedAt: iso(8 * 60 + 14),
      finishedAt: iso(0),
      lastActivityAt: null,
      currentNode: null,
      lastTool: null,
    },
  ] satisfies Run[];
}

function mergeCounts(a: RunCounts, b: RunCounts): RunCounts {
  return {
    all: a.all + b.all,
    running: a.running + b.running,
    paused: a.paused + b.paused,
    failed: a.failed + b.failed,
    completed: a.completed + b.completed,
    cancelled: a.cancelled + b.cancelled,
    pending: a.pending + b.pending,
  };
}

function countsFromRuns(runs: Run[]): RunCounts {
  const out: RunCounts = { ...EMPTY_COUNTS };
  for (const r of runs) {
    out.all += 1;
    if (r.status === 'running') out.running += 1;
    else if (r.status === 'paused') out.paused += 1;
    else if (r.status === 'failed') out.failed += 1;
    else if (r.status === 'completed') out.completed += 1;
    else if (r.status === 'cancelled') out.cancelled += 1;
  }
  return out;
}

function filterRuns(runs: Run[], filter: Filter, query: string): Run[] {
  const q = query.trim().toLowerCase();
  return runs.filter(r => {
    if (filter !== 'all' && r.status !== filter) return false;
    if (q.length === 0) return true;
    return (
      r.workflow.toLowerCase().includes(q) ||
      (r.projectName ?? '').toLowerCase().includes(q) ||
      r.id.toLowerCase().startsWith(q)
    );
  });
}

interface SectionHeaderProps {
  label: string;
  count: number;
}

function SectionHeader({ label, count }: SectionHeaderProps): ReactElement {
  return (
    <div className="mb-2 flex items-center gap-2 px-0.5">
      <span className="text-small font-medium text-text-tertiary">{label}</span>
      <span
        className="rounded-full border bg-surface-elevated px-2 py-px text-mini tabular-nums text-text-secondary"
        style={{ borderColor: 'var(--border)' }}
      >
        {count}
      </span>
    </div>
  );
}

interface RunsFeedProps {
  runs: Run[];
  showProject: boolean;
  draftProject: { id: string; path: string } | null;
  selectedRunId: string | null;
  /** Run ids whose approval is currently shown in the pending-input banner. */
  promotedRunIds: ReadonlySet<string>;
  /** How many runs exist in this scope, which may exceed how many were fetched. */
  total: number;
  /**
   * Runs that say `running` but have gone silent past what their workflow
   * normally takes. Judged by the PARENT, because the median span has to be
   * learned from the full run history and these runs are already filtered.
   */
  stalledRunIds: ReadonlySet<string>;
}

/**
 * Feed split into Active (running + paused) and Recent (completed / failed /
 * cancelled). Active cards get real estate; Recent collapses to compact rows.
 * Matches the attention model: completed runs rarely get checked unless
 * something went wrong — so failed stays eye-catching, completed is muted.
 *
 * When a project is scoped, a DraftRunCard sits at the top of Active — same
 * card shape as a paused-approval card, just waiting for YOU instead of
 * the agent. Starting a new run is "another card in the list."
 */
function RunsFeed({
  runs,
  showProject,
  draftProject,
  selectedRunId,
  promotedRunIds,
  total,
  stalledRunIds,
}: RunsFeedProps): ReactElement {
  const active = runs.filter(r => r.status === 'running' || r.status === 'paused');
  const recent = runs.filter(
    r => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled'
  );

  const showActiveSection = active.length > 0 || draftProject !== null;

  return (
    <div className="flex flex-col gap-x-[19.5px] gap-y-[15.5px]">
      {showActiveSection ? (
        <section>
          <SectionHeader label="Active" count={active.length} />
          <div className="flex flex-col gap-x-2 gap-y-1.25">
            {draftProject !== null ? (
              <DraftRunCard projectId={draftProject.id} projectCwd={draftProject.path} />
            ) : null}
            {active.map(run => (
              <ActiveRunCard
                key={run.id}
                run={run}
                showProject={showProject}
                selected={run.id === selectedRunId}
                inputPromoted={promotedRunIds.has(run.id)}
                stalled={stalledRunIds.has(run.id)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section>
          <SectionHeader label="Recent" count={recent.length} />
          <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
            {recent.map(run => (
              <RecentRunRow
                key={run.id}
                run={run}
                showProject={showProject}
                selected={run.id === selectedRunId}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* A cap that is not stated reads as completeness. */}
      {total > runs.length ? (
        <p className="text-small text-text-tertiary">
          Showing the {runs.length} most recent of {total} runs.
        </p>
      ) : null}
    </div>
  );
}

export function RunsPage(): ReactElement {
  const { projectId } = useParams<{ projectId?: string }>();
  const navigate = useNavigate();
  const scope: Scope = projectId ?? 'all';
  const [searchParams] = useSearchParams();
  const demoMode = searchParams.get('demo') === '1';

  // Land on the view this project was last opened in, and on Overview when it
  // has never been opened. Overview is the default because it answers "what is
  // this and where is it" — the question you have on arriving, which a list of
  // runs does not answer.
  //
  // The stored preference still wins, per project: a project you always work in
  // Chat keeps opening in Chat. Only the project's index route redirects — a
  // deep link to a run is explicit, and each tab records itself before
  // navigating, so nothing is ever bounced back. `replace` keeps the skipped
  // entry out of history, so Back still leaves the project rather than
  // ping-ponging.
  useEffect(() => {
    if (projectId === undefined) return;
    const view = readProjectView(projectId) ?? 'overview';
    if (view !== 'runs') {
      void navigate(`/console/p/${projectId}/${view}`, { replace: true });
    }
  }, [projectId, navigate]);

  // Default to `running` — where the user's attention belongs. Completed is a
  // retrospective view, not the first thing to see.
  const [filter, setFilter] = useState<Filter>('running');
  const [query, setQuery] = useState('');
  // Selection index for j/k navigation. -1 = nothing selected.
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Pending-input runs the user has dismissed from the banner this session.
  // Not persisted — the run is still paused, so it re-surfaces on reload.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  // An explicit limit, not the server's silent default. Asking for nothing got
  // 50 rows and no sign that a 51st existed — the response carries `total`, and
  // the page declared it on FeedData and never rendered it. 200 is the server's
  // own cap; asking for more is refused, so this is "everything it will give".
  const { data, loading, error } = useEntity<FeedData>(K.runs(scope), () =>
    skill.listRuns(
      scope === 'all' ? { limit: skill.RUN_LIMIT } : { codebaseId: scope, limit: skill.RUN_LIMIT }
    )
  );

  // Dashboard SSE keeps the runs feed in sync: every workflow_status /
  // dag_node event invalidates the active runs:* cache keys, triggering a
  // refetch through useEntity. Replaces the 3s polling loop.

  // Scoped project (drives the DraftRunCard inside the feed when not ALL).
  // Typed as `Project | null` rather than `Project` so the ALL scope can
  // legitimately resolve to null without a `null as unknown as Project`
  // type cast hiding the truth from later readers.
  const { data: project } = useEntity<Project | null>(
    scope === 'all' ? 'noop:scope-all' : K.project(scope),
    () => (scope === 'all' ? Promise.resolve(null) : skill.getProject(scope))
  );

  const realRuns = data?.runs ?? [];
  const realCounts = data?.counts ?? EMPTY_COUNTS;

  const demoRuns = useMemo(
    () => (demoMode ? buildDemoRuns(scope, project?.name ?? null) : []),
    [demoMode, scope, project?.name]
  );
  const demoCounts = useMemo(() => countsFromRuns(demoRuns), [demoRuns]);

  const allRuns = [...demoRuns, ...realRuns];
  const counts = demoMode ? mergeCounts(realCounts, demoCounts) : realCounts;
  const runs = useMemo(() => filterRuns(allRuns, filter, query), [allRuns, filter, query]);
  // Judged over ALL runs, not the filtered view: the median span a workflow
  // normally takes has to be learned from its history, and filtering to
  // `running` would leave nothing finished to learn from.
  const now = useNow();
  const stalled = useMemo(() => stalledIds(allRuns, now), [allRuns, now]);

  // Runs paused on a human gate (approval node / agent question). Derived from
  // the unfiltered set on purpose: a run that needs you should surface even
  // while the feed is filtered to `completed` or a search is active.
  const pendingRuns = useMemo(
    () =>
      allRuns.filter(r => r.status === 'paused' && r.approval !== null && r.approval !== undefined),
    [allRuns]
  );

  // Drop dismissed ids that are no longer pending so a run that pauses again
  // (a later approval node, or a repeating interactive loop gate) re-surfaces
  // instead of staying suppressed for the rest of the session.
  useEffect(() => {
    setDismissed(prev => {
      if (prev.size === 0) return prev;
      const pendingIds = new Set(pendingRuns.map(r => r.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (pendingIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [pendingRuns]);

  const visiblePending = useMemo(
    () => pendingRuns.filter(r => !dismissed.has(r.id)),
    [pendingRuns, dismissed]
  );
  const promotedRunIds = useMemo(() => new Set(visiblePending.map(r => r.id)), [visiblePending]);

  const hasScopedProject = scope !== 'all' && project !== undefined && project !== null;
  const draftProject = hasScopedProject ? { id: project.id, path: project.path } : null;

  // Clamp selection when the visible run set changes so j/k never lands on
  // an out-of-range index after a filter / search shrinks the list.
  useEffect(() => {
    if (selectedIndex >= runs.length) setSelectedIndex(runs.length - 1);
  }, [runs.length, selectedIndex]);

  const selectedRun = selectedIndex >= 0 ? (runs[selectedIndex] ?? null) : null;
  const selectedRunId = selectedRun?.id ?? null;

  // Scroll the selected row into view after j/k moves the index. The
  // RecentRunRow / ActiveRunCard emit a data attribute we can target.
  // CSS.escape guards against ids containing CSS-special chars (`:`, `.`,
  // etc.) — without it the selector throws SyntaxError.
  useEffect(() => {
    if (selectedRunId === null) return;
    const el = document.querySelector(`[data-run-id="${CSS.escape(selectedRunId)}"]`);
    if (el !== null) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedRunId]);

  const bindings = useMemo<readonly Binding[]>(
    () => [
      {
        keys: ['j'],
        label: 'Move down',
        run: (): void => {
          if (runs.length === 0) return;
          setSelectedIndex(i => Math.min(runs.length - 1, (i < 0 ? -1 : i) + 1));
        },
      },
      {
        keys: ['k'],
        label: 'Move up',
        run: (): void => {
          if (runs.length === 0) return;
          setSelectedIndex(i => Math.max(0, (i < 0 ? runs.length : i) - 1));
        },
      },
      {
        keys: ['g', 'g'],
        label: 'Jump to first',
        run: (): void => {
          if (runs.length > 0) setSelectedIndex(0);
        },
      },
      {
        keys: ['G'],
        label: 'Jump to last',
        run: (): void => {
          if (runs.length > 0) setSelectedIndex(runs.length - 1);
        },
      },
      {
        keys: ['Enter'],
        label: 'Open selected',
        when: (): boolean => selectedRun !== null,
        run: (): void => {
          if (selectedRun !== null && !selectedRun.id.startsWith('demo-')) {
            navigate(runDetailPath(selectedRun));
          }
        },
      },
      {
        keys: ['Escape'],
        label: 'Clear selection',
        when: (): boolean => selectedIndex !== -1,
        run: (): void => {
          setSelectedIndex(-1);
        },
      },
      {
        keys: ['/'],
        label: 'Focus search',
        run: (): void => {
          searchRef.current?.focus();
          searchRef.current?.select();
        },
      },
      {
        keys: ['1'],
        label: 'Filter: running',
        run: (): void => {
          setFilter('running');
          setSelectedIndex(-1);
        },
      },
      {
        keys: ['2'],
        label: 'Filter: paused',
        run: (): void => {
          setFilter('paused');
          setSelectedIndex(-1);
        },
      },
      {
        keys: ['3'],
        label: 'Filter: failed',
        run: (): void => {
          setFilter('failed');
          setSelectedIndex(-1);
        },
      },
      {
        keys: ['4'],
        label: 'Filter: completed',
        run: (): void => {
          setFilter('completed');
          setSelectedIndex(-1);
        },
      },
      {
        keys: ['5'],
        label: 'Filter: all',
        run: (): void => {
          setFilter('all');
          setSelectedIndex(-1);
        },
      },
    ],
    [navigate, runs, selectedIndex, selectedRun]
  );
  useKeymap({ bindings });

  return (
    <section className="flex h-full flex-col">
      {/* Status sub-tabs and search on one strip. The project name, path and
          Runs/Chat tabs moved to the layout's header — see ProjectLayout. */}
      <div className="flex min-w-0 shrink-0 items-center gap-3 border-b border-border px-4.75">
        {/* The chips scroll inside their own strip rather than pushing the
            search box off the right edge. At 768px the five chips plus a
            300px search box are 170px wider than the viewport, and the whole
            page was scrolling sideways to fit them. */}
        <div className="scroll-x-quiet min-w-0 flex-1">
          <FilterChips value={filter} onChange={setFilter} counts={counts} />
        </div>
        <div className="shrink-0 py-1.25">
          <div
            className="flex h-[38px] w-[300px] max-w-[34vw] shrink-0 items-center gap-2 rounded-lg border bg-surface-elevated px-3 text-text-tertiary transition-colors focus-within:text-text-secondary"
            // Inline because the console scope's wildcard border-color rule
            // repaints Tailwind border utilities (see theme.css).
            style={{ borderColor: 'var(--border)' }}
          >
            <span aria-hidden className="text-body leading-none">
              ⌕
            </span>
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={e => {
                setQuery(e.target.value);
              }}
              onKeyDown={e => {
                // Esc unfocuses + clears so `/` → type → esc returns control
                // to the global keymap without trapping the user in the box.
                if (e.key === 'Escape') {
                  e.currentTarget.blur();
                  setQuery('');
                }
              }}
              aria-label="Search runs"
              placeholder="Search workflow, project, run id…"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>
        </div>
      </div>

      <PendingInputBanner
        runs={visiblePending}
        showProject={scope === 'all'}
        onDismiss={runId => {
          setDismissed(prev => {
            const next = new Set(prev);
            next.add(runId);
            return next;
          });
        }}
      />

      <div className="flex-1 overflow-y-auto px-[23.5px] pb-[18.5px] pt-[13.5px]">
        {error !== undefined && !demoMode ? (
          <EmptyState title="Could not load runs." hint={error.message} />
        ) : loading && !demoMode ? (
          <EmptyState title="Loading…" />
        ) : runs.length === 0 && draftProject === null ? (
          <EmptyState
            title={
              filter === 'running'
                ? 'Nothing running right now.'
                : filter === 'all'
                  ? 'No runs yet.'
                  : `No ${filter} runs.`
            }
            hint={scope === 'all' ? 'Start one from a project.' : undefined}
          />
        ) : (
          <RunsFeed
            stalledRunIds={stalled}
            runs={runs}
            showProject={scope === 'all'}
            draftProject={draftProject}
            selectedRunId={selectedRunId}
            promotedRunIds={promotedRunIds}
            total={data?.total ?? runs.length}
          />
        )}
      </div>
    </section>
  );
}
