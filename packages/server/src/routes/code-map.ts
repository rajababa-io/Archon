/**
 * The changes in flight on a project, as the Overview's live code map draws
 * them (#348): every open pull request into the base branch with its CI
 * rollup, the pull requests merged recently, and the worktree branches a chat
 * is coding on that have no pull request yet.
 *
 * What is LIVE is not answered here. The map reads that from the project's
 * deploy answer, which already owns the running commit and the merged-but-not-
 * live list; a second reading of the same thing here would be a second truth.
 *
 * Read-only. Nothing here writes to GitHub or to a branch.
 */

import { execFileAsync } from '@archon/git';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('code-map');
  return cachedLog;
}

/** A pull request's checks, rolled up the way GitHub's own badge rolls them up. */
export type CiState = 'none' | 'running' | 'passed' | 'failed';

export interface CodeMapChecks {
  state: CiState;
  total: number;
  /** Checks that have finished, passed or not. */
  done: number;
  /** The first failing check's name, for "CI failed · lint". */
  failedName: string | null;
}

export interface CodeMapPull {
  number: number;
  title: string;
  url: string;
  branch: string;
  draft: boolean;
  updatedAt: string;
  checks: CodeMapChecks;
}

export interface CodeMapMerged {
  number: number;
  title: string;
  url: string;
  branch: string;
  mergedAt: string;
}

/** A worktree branch with commits the base does not have, and no pull request. */
export interface CodeMapBranch {
  branch: string;
  commits: number;
  lastCommitAt: string | null;
}

export interface CodeMapResponse {
  /** The branch the map's trunk is. Null when the read stopped before naming one. */
  base: string | null;
  open: CodeMapPull[];
  merged: CodeMapMerged[];
  branches: CodeMapBranch[];
  repo: string | null;
  reason: string | null;
}

/** Recently merged pull requests, enough to cover what any deploy is behind by. */
export const CODE_MAP_MERGED_PAGE = 30;

/**
 * One query: the default branch (the trunk when the project has no deploy
 * row naming one), the open pull requests with their head commit's rollup,
 * and the recently merged ones. `$base` filters both lists to the trunk;
 * `null` lets GitHub return every base, and the caller filters once it knows.
 */
export const CODE_MAP_QUERY = `
  query($owner:String!,$repo:String!,$merged:Int!){
    repository(owner:$owner,name:$repo){
      defaultBranchRef{ name }
      open: pullRequests(first:50, states:[OPEN], orderBy:{field:UPDATED_AT,direction:DESC}){
        nodes{
          number title url headRefName baseRefName isDraft updatedAt
          commits(last:1){ nodes{ commit{ statusCheckRollup{
            state
            contexts(first:100){
              totalCount
              nodes{
                __typename
                ... on CheckRun{ name status conclusion }
                ... on StatusContext{ context state }
              }
            }
          } } } }
        }
      }
      merged: pullRequests(first:$merged, states:[MERGED], orderBy:{field:UPDATED_AT,direction:DESC}){
        nodes{ number title url headRefName baseRefName mergedAt }
      }
    }
  }`;

interface RawContext {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
}

interface RawPull {
  number?: number;
  title?: string;
  url?: string;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  updatedAt?: string;
  mergedAt?: string | null;
  commits?: {
    nodes?: ({
      commit?: {
        statusCheckRollup?: {
          state?: string;
          contexts?: { totalCount?: number; nodes?: (RawContext | null)[] | null } | null;
        } | null;
      } | null;
    } | null)[];
  } | null;
}

interface RawRepo {
  defaultBranchRef?: { name?: string } | null;
  open?: { nodes?: (RawPull | null)[] | null } | null;
  merged?: { nodes?: (RawPull | null)[] | null } | null;
}

/** Conclusions GitHub reports for a check that finished without passing. */
const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

function contextFinished(c: RawContext): boolean {
  if (c.__typename === 'StatusContext') return c.state !== 'PENDING' && c.state !== 'EXPECTED';
  return c.status === 'COMPLETED';
}

function contextFailed(c: RawContext): boolean {
  if (c.__typename === 'StatusContext') return c.state === 'FAILURE' || c.state === 'ERROR';
  return c.status === 'COMPLETED' && FAILED_CONCLUSIONS.has(c.conclusion ?? '');
}

/**
 * GitHub's rollup state is the verdict; the contexts only count. A failure
 * while other checks still run is `failed`, as GitHub's own badge says — the
 * change will not merge as it stands, whatever the rest decide.
 */
export function toChecks(raw: RawPull): CodeMapChecks {
  const rollup = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  if (rollup === null) return { state: 'none', total: 0, done: 0, failedName: null };
  const contexts = (rollup.contexts?.nodes ?? []).filter((c): c is RawContext => c !== null);
  const failed = contexts.find(contextFailed);
  const state: CiState =
    rollup.state === 'SUCCESS'
      ? 'passed'
      : rollup.state === 'FAILURE' || rollup.state === 'ERROR'
        ? 'failed'
        : 'running';
  return {
    state,
    total: rollup.contexts?.totalCount ?? contexts.length,
    done: contexts.filter(contextFinished).length,
    failedName: failed === undefined ? null : (failed.name ?? failed.context ?? null),
  };
}

function pullsOf(conn: { nodes?: (RawPull | null)[] | null } | null | undefined): RawPull[] {
  return (conn?.nodes ?? []).filter((n): n is RawPull => n !== null && n !== undefined);
}

/** The trunk this map draws: the deploy row's branch, else the repository's default. */
export function resolveBase(raw: unknown, deployBranch: string | null): string | null {
  if (deployBranch !== null && deployBranch !== '') return deployBranch;
  return (raw as { repository?: RawRepo }).repository?.defaultBranchRef?.name ?? null;
}

/** The two pull request lists, filtered to the ones that merge into `base`. */
export function toPulls(
  raw: unknown,
  base: string
): { open: CodeMapPull[]; merged: CodeMapMerged[]; closedHeads: Set<string> } {
  const repo = (raw as { repository?: RawRepo }).repository ?? {};
  const open = pullsOf(repo.open)
    .filter(p => p.baseRefName === base)
    .map(p => ({
      number: p.number ?? 0,
      title: p.title ?? '',
      url: p.url ?? '',
      branch: p.headRefName ?? '',
      draft: p.isDraft === true,
      updatedAt: p.updatedAt ?? '',
      checks: toChecks(p),
    }));
  const mergedAll = pullsOf(repo.merged);
  const merged = mergedAll
    .filter(p => p.baseRefName === base && typeof p.mergedAt === 'string')
    .map(p => ({
      number: p.number ?? 0,
      title: p.title ?? '',
      url: p.url ?? '',
      branch: p.headRefName ?? '',
      mergedAt: p.mergedAt ?? '',
    }));
  // Every head a pull request already speaks for, whatever its base: a branch
  // that was squash-merged still has commits "ahead" of the trunk forever, and
  // drawing it as still being coded would be the map lying.
  const closedHeads = new Set(
    [...pullsOf(repo.open), ...mergedAll].map(p => p.headRefName ?? '').filter(h => h !== '')
  );
  return { open, merged, closedHeads };
}

/** A chat counts as working on its branch while it has spoken in the last day. */
const ACTIVE_WITHIN_DAYS = 1;

export interface WorktreeEnv {
  branch_name: string;
  days_since_activity: number | string;
}

/**
 * The worktree branches a recent chat is on that hold commits no remote
 * `base` has, and that no pull request already covers. Counted against every
 * remote's copy of the trunk (`--remotes=*\/base`) so the answer does not
 * depend on what the remote happens to be called in this checkout.
 */
export async function readCodingBranches(
  cwd: string,
  base: string,
  envs: readonly WorktreeEnv[],
  covered: ReadonlySet<string>
): Promise<CodeMapBranch[]> {
  const candidates = [
    ...new Set(
      envs
        .filter(e => Number(e.days_since_activity) < ACTIVE_WITHIN_DAYS)
        .map(e => e.branch_name)
        .filter(b => b !== '' && b !== base && !covered.has(b))
    ),
  ];
  const out = await Promise.all(
    candidates.map(async (branch): Promise<CodeMapBranch | null> => {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-list', '--count', `refs/heads/${branch}`, '--not', `--remotes=*/${base}`],
          { cwd, timeout: 5_000 }
        );
        const commits = Number(stdout.trim());
        if (!Number.isFinite(commits) || commits === 0) return null;
        const last = await execFileAsync(
          'git',
          ['log', '-1', '--format=%cI', `refs/heads/${branch}`],
          {
            cwd,
            timeout: 5_000,
          }
        );
        const lastCommitAt = last.stdout.trim();
        return { branch, commits, lastCommitAt: lastCommitAt === '' ? null : lastCommitAt };
      } catch (err) {
        // Most often a worktree row whose branch was deleted: nothing is being
        // coded on it. Logged, because a git that cannot run reads the same.
        getLog().debug({ err, branch }, 'code_map.branch_read_failed');
        return null;
      }
    })
  );
  return out.filter((b): b is CodeMapBranch => b !== null);
}
