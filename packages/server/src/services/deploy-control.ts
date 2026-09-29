/**
 * The console's per-project deploy controls (#211): what is live, what merged
 * work is waiting, Deploy now, Cancel deploy, and the host's question "should I
 * act on this request?".
 *
 * Only the `archon-host` method exists: this install deploying itself, through
 * the request file `scripts/request-deploy.sh` writes and the host's
 * `scripts/deploy-on-request.sh` consumes. Everything the host writes back —
 * `deploy-history`, `deploy-last.log` — is read through `deploy-status.ts`, the
 * one reader of those files.
 *
 * Who may call the mutating functions is decided by the route, which checks for
 * a person's Cloudflare Access pass first. Nothing in `orchestrator/` imports
 * this module, and no agent tool reaches it.
 */

import { readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getArchonHome } from '@archon/paths/archon-paths';
import { createLogger } from '@archon/paths';
import type { Codebase } from '@archon/core';
import * as projectDeployDb from '@archon/core/db/project-deploy';
import type { ProjectDeploy } from '@archon/core/db/project-deploy';
import { namesDeployPointer } from '@archon/core/db/project-deploy-rules';
import {
  type DeployAttempt,
  type DeployStatus,
  getDeployStatus,
  parseAttempts,
} from './deploy-status';
import type { DeployLogKind } from './deploy-log-kinds';
import { githubGraphQl, isIssueReadFailure, resolveIssueSource } from '../routes/github-issues';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('deploy-control');
  return cachedLog;
}

const SHA = /^[0-9a-f]{40}$/u;

// ─── Live ────────────────────────────────────────────────────────────────────

/**
 * The commit this server was built from, written into the image by the
 * Dockerfile. This is the process answering, so it is what is live — the
 * incoming commit of a deploy in flight cannot appear here until its container
 * is the one serving.
 */
export async function readLiveSha(
  path: string = process.env.ARCHON_DEPLOYED_SHA_FILE ?? '/app/.deployed-sha'
): Promise<string | null> {
  try {
    const sha = (await readFile(path, 'utf8')).trim();
    return SHA.test(sha) ? sha : null;
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
}

/** When the live commit went live: the newest OK verdict for it. */
export function deployedAt(history: string | null, liveSha: string | null): string | null {
  if (history === null || liveSha === null) return null;
  const ok = parseAttempts(history).filter(a => a.verdict === 'OK' && a.sha === liveSha);
  return ok.at(-1)?.at ?? null;
}

async function readHistory(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, 'deploy-history'), 'utf8');
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
}

// ─── Waiting ─────────────────────────────────────────────────────────────────

export interface WaitingPr {
  number: number;
  title: string;
  url: string;
}

export interface Waiting {
  /** The branch tip Deploy now would ship. */
  tipSha: string;
  /** Newest first. */
  prs: WaitingPr[];
  /** More commits than one page reached before the live commit. */
  more: boolean;
}

/** How far back to look for the live commit. Past this, the list says "more". */
export const HISTORY_PAGE = 50;

const WAITING_QUERY = `
  query($owner:String!,$repo:String!,$ref:String!,$first:Int!){
    repository(owner:$owner,name:$repo){
      ref(qualifiedName:$ref){
        target{
          ... on Commit {
            oid
            history(first:$first){
              nodes{
                oid
                associatedPullRequests(first:1){ nodes{ number title url merged } }
              }
            }
          }
        }
      }
    }
  }`;

interface RawHistory {
  repository?: {
    ref?: {
      target?: {
        oid?: string;
        history?: {
          nodes?: ({
            oid?: string;
            associatedPullRequests?: {
              nodes?: ({
                number?: number;
                title?: string;
                url?: string;
                merged?: boolean;
              } | null)[];
            };
          } | null)[];
        };
      };
    } | null;
  };
}

/**
 * The merged PRs on the branch since the live commit, from GitHub's own commit
 * history and PR associations — never from commit subjects. A null `liveSha`
 * means nothing has been deployed yet, so the whole page is waiting.
 *
 * Exported for tests; the route calls {@link readWaiting}.
 */
export function waitingFromHistory(raw: unknown, liveSha: string | null): Waiting | null {
  const target = (raw as RawHistory).repository?.ref?.target;
  const tip = target?.oid;
  if (tip === undefined) return null;
  if (tip === liveSha) return { tipSha: tip, prs: [], more: false };

  const nodes = target?.history?.nodes ?? [];
  const prs: WaitingPr[] = [];
  const seen = new Set<number>();
  let reachedLive = false;
  for (const node of nodes) {
    if (node === null || node === undefined) continue;
    if (node.oid === liveSha) {
      reachedLive = true;
      break;
    }
    const pr = node.associatedPullRequests?.nodes?.find(p => p?.merged === true);
    if (pr?.number !== undefined && !seen.has(pr.number)) {
      seen.add(pr.number);
      prs.push({ number: pr.number, title: pr.title ?? '', url: pr.url ?? '' });
    }
  }
  const more = liveSha === null ? nodes.length >= HISTORY_PAGE : !reachedLive;
  return { tipSha: tip, prs, more };
}

/** Held briefly per (project, live) so a header poll is not a GitHub call. */
const WAITING_TTL_MS = 30_000;
const waitingCache = new Map<
  string,
  { at: number; value: Waiting | null; reason: string | null }
>();

/**
 * What has merged along `branch` since `liveSha`. Null `liveSha` means nothing
 * from this branch is live yet — a caller that merely cannot tell what is live
 * must say so itself rather than pass null.
 */
export async function readWaiting(
  codebase: Codebase,
  branch: string,
  liveSha: string | null
): Promise<{ waiting: Waiting | null; reason: string | null }> {
  const key = `${codebase.id}:${branch}:${liveSha ?? ''}`;
  const hit = waitingCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < WAITING_TTL_MS) {
    return { waiting: hit.value, reason: hit.reason };
  }

  const src = await resolveIssueSource(codebase.id);
  let value: Waiting | null = null;
  let reason: string | null = null;
  if (src === null) reason = 'no-project';
  else if (isIssueReadFailure(src)) reason = src.reason;
  else {
    try {
      const out = await githubGraphQl(src, WAITING_QUERY, {
        owner: src.owner,
        repo: src.repo,
        ref: `refs/heads/${branch}`,
        first: HISTORY_PAGE,
      });
      if ('reason' in out) reason = out.reason;
      else {
        value = waitingFromHistory(out.data, liveSha);
        if (value === null) reason = 'no-branch';
      }
    } catch (err) {
      getLog().warn({ err, codebaseId: codebase.id }, 'deploy.waiting_read_failed');
      reason = 'unreachable';
    }
  }
  waitingCache.set(key, { at: Date.now(), value, reason });
  return { waiting: value, reason };
}

/** Forget cached waiting lists. Called after a deploy request, and by tests. */
export function resetWaitingCache(): void {
  waitingCache.clear();
}

// ─── The view the header draws ───────────────────────────────────────────────

export interface ProjectDeployView {
  method: 'archon-host';
  deployOnMerge: boolean;
  branch: string;
  live: { sha: string | null; deployedAt: string | null };
  waiting: Waiting | null;
  waitingReason: string | null;
  /** The install's deploy, as `/api/health` reports it. */
  status: DeployStatus;
  /** Whether Cancel deploy can still stop what is in flight. */
  cancellable: boolean;
}

/**
 * The phases a cancel can still stop. From step 6 the container is being
 * replaced, and stopping that half-way is worse than letting it finish.
 */
export function isCancellable(phase: DeployStatus['phase']): boolean {
  return phase === 'requested' || phase === 'building' || phase === 'draining';
}

export async function getProjectDeployView(
  codebase: Codebase,
  setting: ProjectDeploy,
  dir: string = getArchonHome()
): Promise<ProjectDeployView> {
  const [liveSha, history, status] = await Promise.all([
    readLiveSha(),
    readHistory(dir),
    getDeployStatus(dir),
  ]);
  const { waiting, reason } = namesDeployPointer(setting)
    ? { waiting: null, reason: 'branch-is-deploy-pointer' }
    : liveSha === null
      ? { waiting: null, reason: 'live-unknown' }
      : await readWaiting(codebase, setting.branch, liveSha);
  return {
    method: 'archon-host',
    deployOnMerge: setting.deployOnMerge,
    branch: setting.branch,
    live: { sha: liveSha, deployedAt: deployedAt(history, liveSha) },
    waiting: waiting !== null && waiting.prs.length === 0 && !waiting.more ? null : waiting,
    waitingReason: reason,
    status,
    cancellable: isCancellable(status.phase),
  };
}

// ─── The log on the Overview tab ─────────────────────────────────────────────

export interface DeployLogEntry {
  at: string;
  kind: DeployLogKind;
  actor: string | null;
  sha: string | null;
  detail: string | null;
}

function fromAttempt(attempt: DeployAttempt): DeployLogEntry {
  const kind = attempt.verdict.toLowerCase() as Lowercase<DeployAttempt['verdict']>;
  return {
    at: attempt.at,
    kind,
    actor: null,
    sha: SHA.test(attempt.sha) ? attempt.sha : null,
    detail: attempt.reason ?? null,
  };
}

/** The console's actions merged with the host's verdicts, newest first. */
export async function getDeployLog(
  codebaseId: string,
  dir: string = getArchonHome(),
  limit = 50
): Promise<DeployLogEntry[]> {
  const [events, history] = await Promise.all([
    projectDeployDb.listDeployEvents(codebaseId, limit),
    readHistory(dir),
  ]);
  const entries: DeployLogEntry[] = [
    ...events.map(e => ({ at: e.at, kind: e.kind, actor: e.actor, sha: e.sha, detail: null })),
    ...(history === null ? [] : parseAttempts(history).map(fromAttempt)),
  ];
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

// ─── Deploy now ──────────────────────────────────────────────────────────────

/**
 * Beside this module, not in the repository's `scripts/`: the image copies the
 * server package but not `scripts/`, and this must be the version the running
 * server was built with. What it hands over to — `scripts/request-deploy.sh` —
 * is run from the checkout of the commit being deployed.
 */
const TIP_SCRIPT = resolve(import.meta.dir, 'request-deploy-tip.sh');

export type DeployNowResult =
  | { ok: true; requestId: string }
  | { ok: false; status: 409 | 500; error: string };

/**
 * Ask the host to deploy the branch tip the person was shown.
 *
 * The event is recorded BEFORE the request is written, because its id is the
 * token the host checks, and the host acts within moments of the file appearing.
 * A request that then fails to be written leaves a `deploy_requested` row with
 * no deploy after it — which is what happened: a person asked, and nothing ran.
 */
export async function deployNow(
  codebase: Codebase,
  setting: ProjectDeploy,
  expectSha: string,
  actor: string,
  run: (
    cmd: string[],
    env: Record<string, string>
  ) => Promise<{ code: number; stderr: string }> = runScript
): Promise<DeployNowResult> {
  if (!SHA.test(expectSha)) return { ok: false, status: 409, error: 'Not a commit SHA.' };
  if (namesDeployPointer(setting)) {
    // Its tip is what is already deployed, not what has merged; shipping it
    // would look like a deploy and change nothing.
    return {
      ok: false,
      status: 409,
      error: `This deploy follows ${setting.branch}, the pointer deploys move. It must follow the branch merges land on.`,
    };
  }
  const status = await getDeployStatus();
  if (status.phase !== 'idle') {
    return { ok: false, status: 409, error: 'A deploy is already requested or running.' };
  }

  const requestId = await projectDeployDb.recordDeployEvent(
    codebase.id,
    'deploy_requested',
    actor,
    expectSha
  );
  const src = await resolveIssueSource(codebase.id);
  const token = src !== null && !isIssueReadFailure(src) ? src.token : undefined;
  const result = await run(['bash', TIP_SCRIPT], {
    SOURCE_DIR: codebase.default_cwd,
    EXPECT_SHA: expectSha,
    DEPLOY_REQUEST_ID: requestId,
    DEV_BRANCH: setting.branch,
    VOLUME: getArchonHome(),
    ...(token !== undefined ? { GITHUB_PAT: token } : {}),
  });
  resetWaitingCache();
  if (result.code === 3) {
    return {
      ok: false,
      status: 409,
      error: `${setting.branch} moved since you looked. Refresh and try again.`,
    };
  }
  if (result.code !== 0) {
    getLog().error(
      { code: result.code, stderr: result.stderr.slice(-2000) },
      'deploy.request_failed'
    );
    const last = result.stderr.trim().split('\n').at(-1) ?? '';
    return { ok: false, status: 500, error: `The deploy could not be requested: ${last}` };
  }
  return { ok: true, requestId };
}

async function runScript(
  cmd: string[],
  env: Record<string, string>
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

// ─── Cancel deploy ───────────────────────────────────────────────────────────

export type CancelResult =
  | { ok: true; how: 'withdrawn' | 'signalled' }
  | { ok: false; status: 409; error: string };

/**
 * Stop the deploy in flight, if it has not begun the swap.
 *
 * A request the host has not picked up is withdrawn here and recorded as
 * KILLED in the host's own history format, so the log reads the same whichever
 * side stopped it. One already running is signalled through `deploy-cancel`;
 * the host stops it, cancels the drain, hands parked work back, and records the
 * verdict itself.
 */
export async function cancelDeploy(
  codebaseId: string,
  actor: string,
  dir: string = getArchonHome(),
  now: () => Date = () => new Date()
): Promise<CancelResult> {
  const status = await getDeployStatus(dir);
  if (!isCancellable(status.phase)) {
    return {
      ok: false,
      status: 409,
      error:
        status.phase === 'idle'
          ? 'No deploy is running.'
          : 'Too late to cancel: the new version is already being swapped in.',
    };
  }

  const sha = status.sha ?? null;
  await projectDeployDb.recordDeployEvent(codebaseId, 'deploy_cancelled', actor, sha);

  if (status.phase === 'requested') {
    await rm(join(dir, 'deploy-request'), { force: true });
    const live = await readLiveSha();
    const at = now()
      .toISOString()
      .replace(/\.\d{3}Z$/u, 'Z');
    await appendFile(
      join(dir, 'deploy-history'),
      `${at}  KILLED ${sha ?? '?'} — cancelled from the console before it started; running ${live ?? 'unknown'}\n`
    );
    return { ok: true, how: 'withdrawn' };
  }

  await writeFile(join(dir, 'deploy-cancel'), `${sha ?? ''}\n`);
  return { ok: true, how: 'signalled' };
}

// ─── The host's question ─────────────────────────────────────────────────────

/**
 * What `deploy-on-request.sh` should do with one request: `run`, or
 * `hold:<reason>`. One machine token per answer, because the reader is a shell
 * script and this is the whole of what it needs.
 */
export async function decidePolicy(query: PolicyQuery): Promise<string> {
  const setting = await projectDeployDb.findProjectDeployByMethod('archon-host');
  if (setting === null) return 'hold:no-project';
  return decideFor(setting, query);
}

export interface PolicyQuery {
  source: string | undefined;
  sha: string | undefined;
  request: string | undefined;
}

/**
 * The answer for one project's deploy, whichever host is asking: a `merge`
 * request runs only while Deploy on Merge is on, and a `manual` one only with a
 * token the console issued for that commit — which only a person's press makes.
 */
export async function decideFor(setting: ProjectDeploy, query: PolicyQuery): Promise<string> {
  if (query.sha === undefined || !SHA.test(query.sha)) return 'hold:malformed';

  if (query.source === 'manual') {
    const id = query.request ?? '';
    // The column is a UUID on Postgres; anything else would be a query error,
    // not a "no".
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
      return 'hold:not-issued';
    }
    return (await projectDeployDb.isIssuedManualRequest(setting.codebaseId, id, query.sha))
      ? 'run'
      : 'hold:not-issued';
  }
  if (query.source === 'merge') {
    return setting.deployOnMerge ? 'run' : 'hold:toggle-off';
  }
  return 'hold:unknown-source';
}
