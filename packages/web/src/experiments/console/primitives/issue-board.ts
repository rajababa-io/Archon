/**
 * Where an issue sits on the board.
 *
 * Read-only derivation. Nothing here writes to GitHub.
 *
 *   done    ← issue.state === CLOSED                          (GitHub)
 *   <label> ← a `status:` label names the column              (GitHub)
 *   rev     ← an open PR lists it in closingIssuesReferences  (GitHub GraphQL)
 *   prog    ← an Archon run is executing against it           (Archon runs)
 *   todo    ← everything else
 *
 * GitHub alone gives you Open and Closed; an issue has no status field, and
 * the Projects board that would supply one does not exist for these repos.
 * The columns in between therefore come from two places, in this order.
 *
 * A `status:` label is a PERSON saying where the work is, so it outranks both
 * derivations — including `status: todo`, which is how an issue is pulled back
 * out of a column the PR heuristic put it in. The derivations remain because
 * they cost nobody any bookkeeping: an open PR that closes an issue really is
 * review, whether or not anyone labelled it.
 *
 * Each placement carries the reason that produced it, so hovering a card says
 * which source put it there rather than leaving the join to be guessed.
 */
import type { GithubIssue } from '../skills';

export type IssueColumn = 'todo' | 'blocked' | 'prog' | 'rev' | 'done';

export const ISSUE_COLUMNS: readonly { key: IssueColumn; label: string; color: string }[] = [
  { key: 'todo', label: 'Todo', color: 'var(--text-tertiary)' },
  { key: 'blocked', label: 'Blocked', color: 'var(--error)' },
  { key: 'prog', label: 'In Progress', color: 'var(--running)' },
  { key: 'rev', label: 'In Review', color: 'var(--warning, var(--st-rev, oklch(0.75 0.15 85)))' },
  { key: 'done', label: 'Done', color: 'var(--success)' },
];

/** Shown when a column is empty, so "0" says why rather than only how many. */
export const COLUMN_EMPTY: Readonly<Record<IssueColumn, string>> = {
  todo: 'nothing is sitting untouched',
  blocked: 'nothing is labelled `status: blocked`',
  prog: 'nothing is labelled `status: in progress`, and no run is working on an issue',
  rev: 'nothing is labelled `status: in review`, and no open PR closes an issue',
  done: 'no issue is closed',
};

/**
 * A STATUS is a person's claim about where the work is, and GitHub has no
 * field for it — the convention that exists in real repos is a prefixed label,
 * which is what `rajababa-io/wix-access` has used since it had issues.
 */
const STATUS_PREFIX = /^status\s*:\s*/i;

const STATUS_COLUMN: Readonly<Record<string, IssueColumn>> = {
  todo: 'todo',
  blocked: 'blocked',
  'in progress': 'prog',
  'in review': 'rev',
};

/** The column a `status:` label names, or null if the issue carries none. */
export function statusColumn(issue: GithubIssue): IssueColumn | null {
  for (const l of issue.labels) {
    if (!STATUS_PREFIX.test(l.name)) continue;
    const hit = STATUS_COLUMN[l.name.replace(STATUS_PREFIX, '').trim().toLowerCase()];
    if (hit !== undefined) return hit;
  }
  return null;
}

/** Where a card is, and why — the two are produced together so they agree. */
export interface IssuePlacement {
  column: IssueColumn;
  /** Shown on hover, so the join is inspectable. */
  reason: string;
}

export function issuePlacement(
  issue: GithubIssue,
  runningIssueNumbers: ReadonlySet<number>
): IssuePlacement {
  if (issue.state === 'CLOSED') return { column: 'done', reason: 'GitHub · the issue is closed' };
  const declared = statusColumn(issue);
  if (declared !== null) return { column: declared, reason: 'GitHub · a status label says so' };
  if (issue.openPr) return { column: 'rev', reason: 'GitHub · an open PR closes it' };
  if (runningIssueNumbers.has(issue.number))
    return { column: 'prog', reason: 'Archon · a run is working on it' };
  return { column: 'todo', reason: 'GitHub · open, nothing else known' };
}

/** An issue and where it sits on the board. */
export interface PlacedIssue {
  issue: GithubIssue;
  placement: IssuePlacement;
}

/**
 * Every issue in its column, in the order given, every column present even
 * when empty. `typeFilter` keeps only issues of that type; null keeps all.
 */
export function issuesByColumn(
  issues: readonly GithubIssue[],
  runningIssueNumbers: ReadonlySet<number>,
  typeFilter: string | null = null
): Map<IssueColumn, PlacedIssue[]> {
  const out = new Map<IssueColumn, PlacedIssue[]>(ISSUE_COLUMNS.map(c => [c.key, []]));
  for (const issue of issues) {
    if (typeFilter !== null && issueType(issue)?.name !== typeFilter) continue;
    const placement = issuePlacement(issue, runningIssueNumbers);
    out.get(placement.column)?.push({ issue, placement });
  }
  return out;
}

/**
 * The GitHub issue TYPE, or one derived from a legacy label.
 *
 * Types are the MECE taxonomy; labels are not. `bug` as a label meant the same
 * thing before types existed, so it still reads — but the card marks a derived
 * type differently from a real one, because they are not the same claim.
 */
const LEGACY_TYPE: Readonly<Record<string, string>> = {
  bug: 'Bug',
  enhancement: 'Feature',
  documentation: 'Task',
  question: 'Task',
  invalid: 'Task',
  duplicate: 'Task',
  wontfix: 'Task',
};

/**
 * GitHub ships one hex per type, tuned for GitHub's own light UI. Reused
 * verbatim they read at 3.1:1 on white and 3.6:1 on our dark surfaces, so
 * these point at mode-aware tokens instead and inherit the AA tuning.
 */
export const TYPE_COLOR: Readonly<Record<string, string>> = {
  Bug: 'var(--type-bug)',
  Feature: 'var(--type-feature)',
  Task: 'var(--type-task)',
};

export function issueType(issue: GithubIssue): { name: string; derived: boolean } | null {
  if (issue.type !== null && issue.type !== '') return { name: issue.type, derived: false };
  for (const l of issue.labels) {
    const hit = LEGACY_TYPE[l.name.toLowerCase()];
    if (hit !== undefined) return { name: hit, derived: true };
  }
  return null;
}

/**
 * An AREA is a part of the system, and GitHub has no field for it — the
 * convention that exists in real repos is a prefixed label. coleam00/Archon
 * uses exactly this: `area: workflows`, `area: cli`. The prefix is stripped
 * for display, so the chip says `workflows`.
 */
const AREA_PREFIX = /^area\s*:\s*/i;

export function issueAreas(issue: GithubIssue): { name: string; color: string }[] {
  return issue.labels
    .filter(l => AREA_PREFIX.test(l.name))
    .map(l => ({ name: l.name.replace(AREA_PREFIX, ''), color: `#${l.color}` }));
}

/** Issue numbers named by a run that is executing right now. */
export function runningIssues(
  runs: readonly { status: string; userMessage?: string | null }[]
): Set<number> {
  const out = new Set<number>();
  for (const r of runs) {
    if (r.status !== 'running') continue;
    const text = r.userMessage ?? '';
    for (const m of text.matchAll(/#(\d{1,6})\b/g)) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  return out;
}
