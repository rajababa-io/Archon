import { MessageCircle, Play, CircleDot } from 'lucide-react';
import { memo, type ReactElement } from 'react';
import * as skill from '../skills';
import { useEntities, useEntity } from '../store/cache';
import { K } from '../store/keys';

/**
 * The three numbers on a project row: chats, runs, open issues.
 *
 * Fixed-width cells so the columns line up down the whole rail — that is what
 * makes them readable as a table rather than as a row of tokens on each line.
 * Zero renders BLANK. An empty cell says "none" faster than a `0` does, and it
 * keeps the quiet projects quiet. Unknown renders blank too — the issues
 * column has no number when the repo cannot be asked — so the tooltip is what
 * carries the difference between "none" and "could not say".
 *
 * Each row reads its OWN `projectCounts:<id>` entry. If a row ever draws
 * another project's figures, those figures were written under the wrong key
 * rather than fetched wrongly; see `loaderForKey` in store/cache.
 */
function Cell({
  value,
  title,
  tone,
}: {
  value: number | null;
  title: string;
  tone?: 'running' | 'attention';
}): ReactElement {
  return (
    <span
      title={title}
      className={`cell${tone === 'running' ? ' live' : ''}${tone === 'attention' ? ' needs-you' : ''}`}
    >
      {value !== null && value > 0 ? value : ''}
    </span>
  );
}

function ProjectCountCellsImpl({ projectId }: { projectId: string }): ReactElement {
  const { data } = useEntity<skill.ProjectCounts>(K.projectCounts(projectId), () =>
    skill.getProjectCounts(projectId)
  );

  const chats = data?.chats ?? null;
  const runs = data?.runs ?? null;
  const running = data?.running ?? 0;
  const awaiting = data?.awaiting ?? 0;

  return (
    <span className="rail-hide rail-counts">
      {/* Amber wins over blue: waiting on YOU outranks the machine being busy. */}
      <Cell
        value={runs}
        tone={awaiting > 0 ? 'attention' : running > 0 ? 'running' : undefined}
        title={
          runs === null
            ? 'Runs in play'
            : runs === 0
              ? 'Nothing running'
              : [
                  running > 0 ? `${running} running` : null,
                  awaiting > 0 ? `${awaiting} waiting on you` : null,
                ]
                  .filter(Boolean)
                  .join(', ') || `${runs} in play`
        }
      />
      <Cell
        value={chats}
        title={chats === null ? 'Chats' : `${chats} open chat${chats === 1 ? '' : 's'}`}
      />
      <Cell
        value={data?.issues ?? null}
        title={
          data?.issues === null || data?.issues === undefined
            ? 'Open issues — not available for this project'
            : `${data.issues} open issue${data.issues === 1 ? '' : 's'}`
        }
      />
    </span>
  );
}

export interface CountTotals {
  runs: number;
  running: number;
  awaiting: number;
  chats: number;
  /** `null` when no project could report its issues. */
  issues: number | null;
  /** Projects whose issue count is unknown — left out of `issues`. */
  issuesUnknown: number;
}

/**
 * Sum of every project's row. A project still loading adds nothing; one whose
 * issues cannot be asked is left out of the issue total and counted instead,
 * so the tooltip can say the figure is partial rather than claim it is whole.
 */
export function sumProjectCounts(rows: readonly (skill.ProjectCounts | undefined)[]): CountTotals {
  const t: CountTotals = {
    runs: 0,
    running: 0,
    awaiting: 0,
    chats: 0,
    issues: null,
    issuesUnknown: 0,
  };
  for (const r of rows) {
    if (r === undefined) continue;
    t.runs += r.runs;
    t.running += r.running;
    t.awaiting += r.awaiting;
    t.chats += r.chats;
    if (r.issues === null) t.issuesUnknown += 1;
    else t.issues = (t.issues ?? 0) + r.issues;
  }
  return t;
}

/**
 * The same three cells for the All projects row: totals across EVERY project,
 * not only the ones the rail search is showing. Reads the per-project entries
 * the rows already load, so it adds no requests of its own.
 */
export function ProjectCountTotals({
  projectIds,
}: {
  projectIds: readonly string[];
}): ReactElement {
  const rows = useEntities<skill.ProjectCounts>(
    projectIds.map(id => ({
      key: K.projectCounts(id),
      loader: (): Promise<skill.ProjectCounts> => skill.getProjectCounts(id),
    }))
  );
  const t = sumProjectCounts(rows);
  const s = (n: number): string => (n === 1 ? '' : 's');

  return (
    <span className="rail-hide rail-counts">
      <Cell
        value={t.runs}
        tone={t.awaiting > 0 ? 'attention' : t.running > 0 ? 'running' : undefined}
        title={
          t.runs === 0
            ? 'Nothing running in any project'
            : [
                `${t.runs} run${s(t.runs)} in play across all projects`,
                t.running > 0 ? `${t.running} running` : null,
                t.awaiting > 0 ? `${t.awaiting} waiting on you` : null,
              ]
                .filter(Boolean)
                .join(', ')
        }
      />
      <Cell value={t.chats} title={`${t.chats} open chat${s(t.chats)} across all projects`} />
      <Cell
        value={t.issues}
        title={
          t.issues === null
            ? 'Open issues — no project could report them'
            : `${t.issues} open issue${s(t.issues)} across all projects` +
              (t.issuesUnknown > 0
                ? ` (${t.issuesUnknown} project${s(t.issuesUnknown)} could not report)`
                : '')
        }
      />
    </span>
  );
}

/** Header row for the count columns, aligned to the same cell widths. */
export function ProjectCountHeader(): ReactElement {
  const ico = 'h-[11px] w-[11px]';
  return (
    <span aria-hidden className="rail-hide rail-counts">
      {/* Runs, chats, issues — the same order as the project's own tabs, so the
          columns and the tabs teach each other instead of being learned twice. */}
      <span className="cell" title="Runs in play">
        <Play className={ico} />
      </span>
      <span className="cell" title="Chats">
        <MessageCircle className={ico} />
      </span>
      <span className="cell" title="Open issues">
        <CircleDot className={ico} />
      </span>
    </span>
  );
}

/** Memoized: the rail re-renders on every cache event, the numbers rarely change. */
/* eslint-disable-next-line @typescript-eslint/naming-convention --
   A memoized component is a const, and a component must be PascalCase for JSX
   to treat it as one. The rule cannot express "const holding a component". */
export const ProjectCountCells = memo(ProjectCountCellsImpl, (a, b) => a.projectId === b.projectId);
