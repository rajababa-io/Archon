/**
 * Deploys for a project that deploys itself on another host (#220): the
 * `remote-host` method. Vault on Adina is the first — it pulls `main` when
 * GitHub says it moved.
 *
 * Archon does not run these deploys. The host asks Archon's policy before each
 * one — the same answer `archon-host` gets, from `decideFor` — and reports what
 * it did afterwards. Those reports are the only record of what is live there,
 * because the host is the only witness.
 *
 * Deploy now records the `deploy_requested` token first, then asks the host to
 * deploy with it. The host asks the policy with that token like any other
 * request, so whoever reaches the host's address can at most make it ask:
 * only a token a person's press issued is answered `run`.
 *
 * The credential the host presents is looked up by its hash, and it names the
 * project, so a host can ask and report about its own project and no other.
 */

import { createLogger } from '@archon/paths';
import type { Codebase } from '@archon/core';
import * as projectDeployDb from '@archon/core/db/project-deploy';
import type { DeployReport, RemoteHostProjectDeploy } from '@archon/core/db/project-deploy';
import {
  type DeployLogEntry,
  type Waiting,
  readWaiting,
  resetWaitingCache,
} from './deploy-control';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('remote-deploy');
  return cachedLog;
}

const SHA = /^[0-9a-f]{40}$/u;

// ─── The view the header draws ───────────────────────────────────────────────

export interface RemoteDeployView {
  method: 'remote-host';
  deployOnMerge: boolean;
  branch: string;
  /** What the host last said it was running. Null before its first report. */
  live: { sha: string | null; deployedAt: string | null };
  waiting: Waiting | null;
  waitingReason: string | null;
  /** The host's deploy takes seconds and is not Archon's to stop. */
  cancellable: false;
}

/**
 * What is live, from the host's own reports: the commit its newest report says
 * it was running, deployed when its newest `ok` for that commit says.
 */
export function liveFromReports(reports: readonly DeployReport[]): RemoteDeployView['live'] {
  const newest = reports[0];
  if (newest === undefined) return { sha: null, deployedAt: null };
  const ok = reports.find(r => r.verdict === 'ok' && r.sha === newest.liveSha);
  return { sha: newest.liveSha, deployedAt: ok?.at ?? null };
}

export async function getRemoteDeployView(
  codebase: Codebase,
  setting: RemoteHostProjectDeploy
): Promise<RemoteDeployView> {
  const live = liveFromReports(await projectDeployDb.listDeployReports(codebase.id, 50));
  // Before the host's first report nothing says what it runs, and calling the
  // whole branch "waiting" would be a guess.
  const { waiting, reason } =
    live.sha === null
      ? { waiting: null, reason: 'live-unknown' }
      : await readWaiting(codebase, setting.branch, live.sha);
  const nothingNew = waiting !== null && waiting.prs.length === 0 && !waiting.more;
  return {
    method: 'remote-host',
    deployOnMerge: setting.deployOnMerge,
    branch: setting.branch,
    live,
    waiting: nothingNew ? null : waiting,
    waitingReason: reason,
    cancellable: false,
  };
}

// ─── Deploy now ──────────────────────────────────────────────────────────────

export type RemoteDeployNowResult =
  | { ok: true; requestId: string }
  | { ok: false; status: 409 | 502; error: string };

/** Ask the host to deploy. Resolves to the host's HTTP status, or throws when it cannot be reached. */
export type HostCaller = (url: string, body: { sha: string; request: string }) => Promise<number>;

const HOST_TIMEOUT_MS = 10_000;

async function postToHost(url: string, body: { sha: string; request: string }): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
  });
  return res.status;
}

/**
 * Ask the host to deploy the branch tip the person was shown.
 *
 * The tip is re-read first, so a branch that moved since the page drew is
 * refused rather than shipping something nobody looked at. The event is
 * recorded before the host is called because its id is the token the host
 * presents back; a host that then cannot be reached leaves a press with no
 * deploy after it in the log, which is what happened.
 */
export async function deployRemoteNow(
  codebase: Codebase,
  setting: RemoteHostProjectDeploy,
  expectSha: string,
  actor: string,
  call: HostCaller = postToHost
): Promise<RemoteDeployNowResult> {
  if (!SHA.test(expectSha)) return { ok: false, status: 409, error: 'Not a commit SHA.' };

  resetWaitingCache();
  const { waiting, reason } = await readWaiting(codebase, setting.branch, null);
  if (waiting === null) {
    return {
      ok: false,
      status: 502,
      error: `Could not read ${setting.branch} from GitHub (${reason ?? 'unknown'}).`,
    };
  }
  if (waiting.tipSha !== expectSha) {
    return {
      ok: false,
      status: 409,
      error: `${setting.branch} moved since you looked. Refresh and try again.`,
    };
  }

  const requestId = await projectDeployDb.recordDeployEvent(
    codebase.id,
    'deploy_requested',
    actor,
    expectSha
  );
  let status: number;
  try {
    status = await call(setting.remoteUrl, { sha: expectSha, request: requestId });
  } catch (err) {
    getLog().error({ err, codebaseId: codebase.id }, 'deploy.remote_unreachable');
    return { ok: false, status: 502, error: 'The host that deploys this project did not answer.' };
  } finally {
    resetWaitingCache();
  }
  if (status < 200 || status >= 300) {
    getLog().error({ status, codebaseId: codebase.id }, 'deploy.remote_refused');
    return {
      ok: false,
      status: 502,
      error: `The host that deploys this project refused the request (HTTP ${String(status)}).`,
    };
  }
  return { ok: true, requestId };
}

// ─── The log on the Overview tab ─────────────────────────────────────────────

/** The console's actions merged with the host's reports, newest first. */
export async function getRemoteDeployLog(
  codebaseId: string,
  limit = 50
): Promise<DeployLogEntry[]> {
  const [events, reports] = await Promise.all([
    projectDeployDb.listDeployEvents(codebaseId, limit),
    projectDeployDb.listDeployReports(codebaseId, limit),
  ]);
  const entries: DeployLogEntry[] = [
    ...events.map(e => ({ at: e.at, kind: e.kind, actor: e.actor, sha: e.sha, detail: null })),
    ...reports.map(r => ({
      at: r.at,
      kind: r.verdict,
      actor: null,
      sha: r.sha,
      detail: r.reason,
    })),
  ];
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}
