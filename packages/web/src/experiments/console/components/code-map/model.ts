/**
 * What the live code map draws, derived from two server answers and nothing
 * else (#348): the code-map read (open pull requests and their CI, recent
 * merges, coding branches) and the project's deploy answer (the running
 * commit, and what has merged since). A line's state is a GitHub or deploy
 * fact; no state here is inferred from a title or a chat's prose.
 *
 * Pure, so the map, the mobile list and the tests read one derivation.
 */
import type { CodeMapResponse, DeployLogEntry, DeployLogKind, ProjectDeploy } from '../../skills';
import { DEPLOY_LOG_LABEL } from '../../lib/deploy-row';
import { relativeTime } from '../../lib/format';

/** Where one change is. Each maps to one of the chat-dot status colours. */
export type ChangeState =
  | 'coding'
  | 'pr-open'
  | 'ci-running'
  | 'ci-passed'
  | 'ci-failed'
  | 'merged';

/** One line on the map: an open or merged pull request, or a branch with no pull request yet. */
export interface CodeMapChange {
  /** Stable across states, so a line keeps its lane and animates when it merges. */
  key: string;
  number: number | null;
  title: string;
  url: string | null;
  branch: string;
  state: ChangeState;
  /** CI progress, for an open pull request whose checks are running. */
  checks: { done: number; total: number } | null;
  /** The failing check, for `ci-failed`. */
  failedName: string | null;
  draft: boolean;
  commits: number | null;
  mergedAt: string | null;
}

/**
 * One place the code runs. A list, not a field: today a project has one —
 * its deploy — and a dev/tst/stg/prd chain is more of the same rows.
 */
export interface CodeMapEnvironment {
  id: string;
  label: string;
  /** The running commit. Null when the deploy cannot say what is live. */
  sha: string | null;
  since: string | null;
  /** Merged changes this environment does not have yet. */
  behind: number;
  /** The server capped the list it counted, so `behind` is a floor. */
  behindMore: boolean;
  /**
   * The last deploy attempt, when it did not go live: the running commit is
   * then older than someone meant it to be, and the line says so.
   */
  lastFailure: { label: string; at: string } | null;
}

/** Log kinds that end a deploy attempt. */
const ENDINGS: ReadonlySet<DeployLogKind> = new Set([
  'ok',
  'failed',
  'refused',
  'killed',
  'not_started',
]);

/** The newest ending in the log, when it is not `ok`. The log is newest first. */
function lastFailure(log: readonly DeployLogEntry[]): CodeMapEnvironment['lastFailure'] {
  const last = log.find(e => ENDINGS.has(e.kind));
  if (last === undefined || last.kind === 'ok') return null;
  return { label: DEPLOY_LOG_LABEL[last.kind], at: last.at };
}

/**
 * The colour for each state, from the chat-dot palette and nothing else:
 * coding blue, CI violet, needs-you orange, merged pink, failed red.
 */
export const STATE_COLOR: Record<ChangeState, string> = {
  coding: 'var(--status-working)',
  'pr-open': 'var(--status-working)',
  'ci-running': 'var(--status-waiting)',
  'ci-passed': 'var(--status-awaiting)',
  'ci-failed': 'var(--error)',
  merged: 'var(--status-ready)',
};

export const DEPLOYED_COLOR = 'var(--status-done)';

/** The legend, in the order a change moves through it. */
export const LEGEND: readonly { label: string; color: string }[] = [
  { label: 'coding', color: 'var(--status-working)' },
  { label: 'CI running', color: 'var(--status-waiting)' },
  { label: 'needs you', color: 'var(--status-awaiting)' },
  { label: 'merged', color: 'var(--status-ready)' },
  { label: 'deployed', color: DEPLOYED_COLOR },
  { label: 'failed', color: 'var(--error)' },
];

function openState(checks: CodeMapResponse['open'][number]['checks']): ChangeState {
  switch (checks.state) {
    case 'running':
      return 'ci-running';
    case 'passed':
      return 'ci-passed';
    case 'failed':
      return 'ci-failed';
    case 'none':
      return 'pr-open';
  }
}

/**
 * Every change in flight, oldest pull request first so a line keeps its lane
 * as it moves from CI to merged. Branches with no pull request sit after them.
 *
 * Merged-but-not-live is the deploy's answer: a pull request the deploy lists
 * as waiting, or one GitHub says merged after the running commit went live
 * (it cannot be in what is running). The second rule covers the gap while the
 * deploy's own list catches up. With no deploy set up, nothing is "not live"
 * and a merge simply leaves the map.
 */
export function deriveChanges(
  map: CodeMapResponse | undefined,
  deploy: ProjectDeploy | null
): CodeMapChange[] {
  const out: CodeMapChange[] = [];
  for (const pr of map?.open ?? []) {
    out.push({
      key: `pr:${String(pr.number)}`,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      branch: pr.branch,
      state: openState(pr.checks),
      checks:
        pr.checks.state === 'running' ? { done: pr.checks.done, total: pr.checks.total } : null,
      failedName: pr.checks.failedName,
      draft: pr.draft,
      commits: null,
      mergedAt: null,
    });
  }

  if (deploy !== null) {
    const open = new Set(out.map(c => c.number));
    const waiting = new Map((deploy.waiting?.prs ?? []).map(p => [p.number, p]));
    const liveAt = deploy.live.deployedAt === null ? null : Date.parse(deploy.live.deployedAt);
    const mergedByNumber = new Map((map?.merged ?? []).map(m => [m.number, m]));
    const numbers = new Set<number>(waiting.keys());
    for (const m of map?.merged ?? []) {
      if (liveAt !== null && Date.parse(m.mergedAt) > liveAt) numbers.add(m.number);
    }
    for (const n of numbers) {
      if (open.has(n)) continue;
      const m = mergedByNumber.get(n);
      const w = waiting.get(n);
      out.push({
        key: `pr:${String(n)}`,
        number: n,
        title: m?.title ?? w?.title ?? '',
        url: m?.url ?? w?.url ?? null,
        branch: m?.branch ?? '',
        state: 'merged',
        checks: null,
        failedName: null,
        draft: false,
        commits: null,
        mergedAt: m?.mergedAt ?? null,
      });
    }
  }

  out.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  for (const b of map?.branches ?? []) {
    out.push({
      key: `branch:${b.branch}`,
      number: null,
      title: b.branch,
      url: null,
      branch: b.branch,
      state: 'coding',
      checks: null,
      failedName: null,
      draft: false,
      commits: b.commits,
      mergedAt: null,
    });
  }
  return out;
}

/**
 * The environments, from the deploy answer and its log. One today; the shape is a list so
 * the map draws more without changing. `behind` counts every merged line the
 * map shows, so the number on the deploy line and the pink lines above it
 * agree by construction.
 */
export function deriveEnvironments(
  deploy: ProjectDeploy | null,
  changes: readonly CodeMapChange[],
  log: readonly DeployLogEntry[] = []
): CodeMapEnvironment[] {
  if (deploy === null) return [];
  return [
    {
      id: 'deploy',
      label:
        deploy.method === 'workflow' && deploy.productionBranch !== null
          ? deploy.productionBranch
          : 'deploy',
      sha: deploy.live.sha,
      since: deploy.live.deployedAt,
      behind: changes.filter(c => c.state === 'merged').length,
      behindMore: deploy.waiting?.more === true,
      lastFailure: lastFailure(log),
    },
  ];
}

/**
 * A pull request title that already leads with its issue (`#346 Mobile pill`)
 * is shown as it is: prefixing the PR number would read as two issues.
 */
export function lineLabel(c: CodeMapChange): string {
  if (c.number === null || c.title.startsWith('#')) return c.title;
  return `#${String(c.number)} ${c.title}`;
}

/** The words beside a line: what state it is in, in the console's own terms. */
export function stateDetail(c: CodeMapChange, now: number = Date.now()): string {
  const draft = c.draft ? 'draft · ' : '';
  switch (c.state) {
    case 'coding':
      return `coding · ${String(c.commits ?? 0)} commit${c.commits === 1 ? '' : 's'}`;
    case 'pr-open':
      return `${draft}PR open · no checks yet`;
    case 'ci-running':
      return c.checks === null || c.checks.total === 0
        ? `${draft}CI running`
        : `${draft}CI running · ${String(c.checks.done)} of ${String(c.checks.total)} checks`;
    case 'ci-passed':
      return `${draft}checks passed · ready to merge`;
    case 'ci-failed':
      return c.failedName === null ? `${draft}CI failed` : `${draft}CI failed · ${c.failedName}`;
    case 'merged':
      return c.mergedAt === null
        ? 'merged · not live'
        : `merged ${relativeTime(c.mergedAt, now)} · not live`;
  }
}

/** Keys that were open last read and are merged now: the lines to animate into the trunk. */
export function newlyMerged(
  before: readonly CodeMapChange[],
  after: readonly CodeMapChange[]
): string[] {
  const was = new Map(before.map(c => [c.key, c.state]));
  return after
    .filter(c => c.state === 'merged')
    .filter(c => {
      const prev = was.get(c.key);
      return prev !== undefined && prev !== 'merged';
    })
    .map(c => c.key);
}
