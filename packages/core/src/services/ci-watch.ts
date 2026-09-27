/**
 * Firing a chat's CI watch: once, when every check on its commit has finished.
 *
 * Two callers drive this. A `check_run` webhook is the primary signal — it says
 * WHICH commit may have finished. The reconcile sweep is the safety net for
 * deliveries that never arrived (a restart, a webhook not yet configured, a
 * GitHub outage). Neither trusts the event it was woken by: one `check_run`
 * arrives per job, so completion is always re-read from the forge for the
 * whole commit before anything is sent.
 */
import { createLogger } from '@archon/paths';
import {
  claimCiWatch,
  listOpenCiWatches,
  listOpenCiWatchesForHead,
  releaseCiWatch,
  type CiWatch,
} from '../db/ci-watches';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('ci-watch');
  return cachedLog;
}

/** One finished check, as the message reports it. */
export interface FinishedCheck {
  name: string;
  /** The forge's own conclusion word, e.g. `success`, `failure`, `skipped`. */
  conclusion: string;
}

/**
 * The forge's answer for one commit. `pending` covers both "some check is still
 * running" and "no check has been created yet" — a commit whose CI has not
 * started is not a commit whose CI passed. `unreadable` is a refusal that will
 * not change by waiting (the credential lacks access to the repository's CI),
 * so the watch says so at once rather than hold the chat until it expires.
 */
export type HeadChecks =
  | { kind: 'pending' }
  | { kind: 'complete'; checks: FinishedCheck[] }
  | { kind: 'unreadable'; reason: string };

/**
 * `refused`: the server would not start a turn (it is draining for a restart),
 * so nothing reached the chat and the watch is handed back to fire later.
 * `delivered`: the chat has the message.
 */
export type CiWatchDelivery = 'delivered' | 'refused';

export interface CiWatchDeps {
  readHeadChecks(repo: string, headSha: string): Promise<HeadChecks>;
  deliver(watch: CiWatch, message: string): Promise<CiWatchDelivery>;
}

/**
 * How long a watch waits before it reports that CI never finished. A commit
 * with no CI configured, or a check stuck queued, would otherwise hold a chat
 * on "Waiting on CI" and be polled forever.
 */
export const CI_WATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Conclusions that do not fail a commit. Everything else is named in the message. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

type Verdict =
  | { kind: 'complete'; checks: FinishedCheck[] }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'expired' };

const MACHINE_HEADER =
  '[Automated message from the CI watch this chat opened with `watch_ci` — not written by a person.]';

function describeTarget(watch: CiWatch): string {
  const pr = watch.pullRequest === null ? '' : ` (PR #${String(watch.pullRequest)})`;
  return `${watch.repo}@${watch.headSha.slice(0, 7)}${pr}`;
}

export function ciWatchMessage(watch: CiWatch, verdict: Verdict): string {
  const target = describeTarget(watch);
  if (verdict.kind === 'unreadable') {
    return `${MACHINE_HEADER}\nCI on ${target} cannot be watched: ${verdict.reason} The watch is closed. Check the commit yourself and tell the user where it stands.`;
  }
  if (verdict.kind === 'expired') {
    return `${MACHINE_HEADER}\nCI never finished on ${target}: after ${String(CI_WATCH_MAX_AGE_MS / 3_600_000)} hours some checks were still pending or none had started. The watch is closed. Check the commit yourself and tell the user where it stands.`;
  }
  const failing = verdict.checks.filter(c => !PASSING_CONCLUSIONS.has(c.conclusion));
  const total = verdict.checks.length;
  if (failing.length === 0) {
    return `${MACHINE_HEADER}\nCI finished on ${target}: all ${String(total)} checks passed. Carry on with whatever was waiting on it, and tell the user.`;
  }
  const names = failing.map(c => `${c.name} (${c.conclusion})`).join(', ');
  return `${MACHINE_HEADER}\nCI finished on ${target}: ${String(failing.length)} of ${String(total)} checks did not pass — ${names}. Look into the failures and tell the user.`;
}

async function fire(watch: CiWatch, verdict: Verdict, deps: CiWatchDeps): Promise<boolean> {
  if (!(await claimCiWatch(watch.id))) return false;
  let delivery: CiWatchDelivery;
  try {
    delivery = await deps.deliver(watch, ciWatchMessage(watch, verdict));
  } catch (err) {
    // Left fired, not released: whether any of the message reached the chat is
    // unknown, and firing at most once outranks firing at all.
    getLog().error(
      { err, watchId: watch.id, conversationId: watch.conversationId },
      'ci_watch.deliver_failed'
    );
    return false;
  }
  if (delivery === 'refused') {
    await releaseCiWatch(watch.id);
    getLog().info({ watchId: watch.id }, 'ci_watch.deliver_refused_released');
    return false;
  }
  getLog().info(
    { watchId: watch.id, conversationId: watch.conversationId, verdict: verdict.kind },
    'ci_watch.fired'
  );
  return true;
}

async function settleGroup(
  repo: string,
  headSha: string,
  watches: CiWatch[],
  deps: CiWatchDeps,
  now: Date | null
): Promise<number> {
  let checks: HeadChecks;
  try {
    checks = await deps.readHeadChecks(repo, headSha);
  } catch (err) {
    // The webhook path has no clock to expire against; the sweep retries it.
    if (now === null) throw err;
    // A read that keeps failing must not also stop the watch expiring, or the
    // chat waits in silence forever. Logged, then treated as still pending.
    getLog().warn({ err, repo, headSha }, 'ci_watch.read_head_failed');
    checks = { kind: 'pending' };
  }
  let fired = 0;
  for (const watch of watches) {
    let verdict: Verdict | null = null;
    if (checks.kind !== 'pending') verdict = checks;
    else if (now !== null && now.getTime() - watch.createdAt.getTime() >= CI_WATCH_MAX_AGE_MS)
      verdict = { kind: 'expired' };
    if (verdict !== null && (await fire(watch, verdict, deps))) fired += 1;
  }
  return fired;
}

/**
 * The webhook path: a check on this commit finished, so ask whether they all
 * have. Returns how many watches fired. A commit nobody is watching costs one
 * indexed read and no forge call.
 */
export async function settleCiWatchesForHead(
  repo: string,
  headSha: string,
  deps: CiWatchDeps
): Promise<number> {
  const watches = await listOpenCiWatchesForHead(repo, headSha);
  if (watches.length === 0) return 0;
  return settleGroup(repo.toLowerCase(), headSha.toLowerCase(), watches, deps, null);
}

/**
 * The safety net: every open watch, whether or not a webhook arrived for it.
 * Also the only place a watch expires — including one whose forge reads keep
 * failing. One commit's failure is logged and skipped so it cannot stall every
 * other chat's watch.
 */
export async function reconcileCiWatches(deps: CiWatchDeps, now = new Date()): Promise<number> {
  const groups = new Map<string, CiWatch[]>();
  for (const watch of await listOpenCiWatches()) {
    const key = `${watch.repo}@${watch.headSha}`;
    const group = groups.get(key);
    if (group) group.push(watch);
    else groups.set(key, [watch]);
  }
  let fired = 0;
  for (const watches of groups.values()) {
    const { repo, headSha } = watches[0];
    try {
      fired += await settleGroup(repo, headSha, watches, deps, now);
    } catch (err) {
      getLog().warn({ err, repo, headSha }, 'ci_watch.reconcile_head_failed');
    }
  }
  return fired;
}

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
let reconcileIntervalId: ReturnType<typeof setInterval> | null = null;

/** Reconcile now (a restart may have swallowed deliveries), then every few minutes. */
export function startCiWatchReconcileScheduler(deps: CiWatchDeps): void {
  if (reconcileIntervalId) {
    getLog().warn('ci_watch.reconcile_scheduler_already_running');
    return;
  }
  const run = (): void => {
    void reconcileCiWatches(deps).catch((err: unknown) => {
      getLog().error({ err }, 'ci_watch.reconcile_failed');
    });
  };
  run();
  reconcileIntervalId = setInterval(run, RECONCILE_INTERVAL_MS);
  reconcileIntervalId.unref();
}

/**
 * Whether this process can fire a watch at all. A server with no GitHub adapter
 * never starts the sweep and has no webhook to hear, so a watch opened there
 * would hold its chat on "Waiting on CI" forever; the tool is not offered.
 */
export function isCiWatchActive(): boolean {
  return reconcileIntervalId !== null;
}

export function stopCiWatchReconcileScheduler(): void {
  if (reconcileIntervalId) {
    clearInterval(reconcileIntervalId);
    reconcileIntervalId = null;
  }
}
