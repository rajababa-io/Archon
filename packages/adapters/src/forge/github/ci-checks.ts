import type { HeadChecks } from '@archon/core/services/ci-watch';

export interface CheckSuiteState {
  status: string | null;
  latest_check_runs_count: number;
}

export interface CheckRunState {
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * Whether every check on a commit has finished, from GitHub's own state.
 *
 * Runs alone cannot answer it. An Actions job that `needs:` another has no
 * check run until its dependency finishes, so the moment the first job
 * completes the run list can read "all complete" while the workflow is still
 * going. Its check SUITE stays open until every job in it has run, so a suite
 * that has runs and is not completed holds the answer at pending.
 *
 * Suites with no runs are ignored: GitHub creates a queued suite for every
 * installed App that could report checks, and one that never does stays
 * queued forever.
 */
export function summarizeHeadChecks(
  suites: readonly CheckSuiteState[],
  runs: readonly CheckRunState[]
): HeadChecks {
  if (runs.length === 0) return { kind: 'pending' };
  if (runs.some(run => run.status !== 'completed')) return { kind: 'pending' };
  if (suites.some(suite => suite.latest_check_runs_count > 0 && suite.status !== 'completed')) {
    return { kind: 'pending' };
  }
  return {
    kind: 'complete',
    checks: runs.map(run => ({ name: run.name, conclusion: run.conclusion ?? 'unknown' })),
  };
}

/**
 * The head commit a completed `check_run` delivery is about, or null.
 *
 * Deliberately wider than `isCheckRunCompletedEvent`, which also demands a
 * pull request: a push to a base branch runs CI with no pull request at all,
 * and a watch on that commit must still hear it finish.
 */
export function parseCompletedCheckRunHead(
  value: unknown
): { repo: string; headSha: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { action, check_run: checkRun, repository } = value as Record<string, unknown>;
  if (action !== 'completed') return null;
  if (typeof checkRun !== 'object' || checkRun === null) return null;
  if (typeof repository !== 'object' || repository === null) return null;
  const headSha = (checkRun as Record<string, unknown>).head_sha;
  const repo = (repository as Record<string, unknown>).full_name;
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(headSha)) return null;
  if (typeof repo !== 'string' || repo === '') return null;
  return { repo, headSha };
}
