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

export interface WorkflowRunState {
  name?: string | null;
  status: string | null;
  conclusion: string | null;
}

/**
 * Whether every GitHub Actions run on a commit has finished.
 *
 * The reading used when the credential cannot see the Checks API: a
 * fine-grained PAT cannot be granted check permissions at all, so on a private
 * repository both check listings answer 403 while the Actions listing, under
 * the `Actions: read` permission, answers. A workflow run stays open until
 * every one of its jobs has run, so the `needs:` gap `summarizeHeadChecks`
 * guards against with suites does not arise here. Checks posted by other Apps
 * are invisible to this reading.
 */
export function summarizeWorkflowRuns(runs: readonly WorkflowRunState[]): HeadChecks {
  if (runs.length === 0) return { kind: 'pending' };
  if (runs.some(run => run.status !== 'completed')) return { kind: 'pending' };
  return {
    kind: 'complete',
    checks: runs.map(run => ({
      name: run.name ?? 'unnamed workflow',
      conclusion: run.conclusion ?? 'unknown',
    })),
  };
}

/**
 * Whether an Octokit error is GitHub declining this credential access to the
 * resource (403, or the 404 it gives for a private resource the caller may not
 * see). Read from the HTTP status, never the message text.
 */
export function isAccessRefusal(err: unknown): err is { status: 403 | 404 } {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown }).status;
  return status === 403 || status === 404;
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
