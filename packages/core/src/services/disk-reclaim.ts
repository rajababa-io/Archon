/**
 * Disk reclaim — gives back space held by regenerable content before the disk
 * fills, and says loudly when it cannot.
 *
 * WHAT IT REMOVES, AND ONLY THIS:
 * - `node_modules` directories inside the worktree of an IDLE environment. A
 *   worktree keeps its code, commits and uncommitted changes untouched; the
 *   next `bun install` (or npm/pnpm) in it rebuilds what was removed.
 * - the bun install cache, and only while nothing in this process holds a turn
 *   and no workflow run is executing, because an install reading the cache as
 *   it disappears fails halfway.
 *
 * IDLE means every one of: no workflow run can still claim the environment, no
 * conversation attached to it has a turn in flight or a message queued, and
 * nothing attached to it has been active for `DISK_RECLAIM_IDLE_HOURS`. A
 * worktree whose `node_modules` is tracked by git is skipped outright — then
 * it is code, not an install.
 *
 * Whole-worktree removal is not here: `cleanup-service.ts` owns that, and it
 * waits for the chat to be closed. This covers the long tail of chats that stay
 * open — each one carries a full install for as long as it does.
 *
 * WHAT IT REPORTS. Every run appends one JSON line to
 * `<archon home>/logs/disk-reclaim.log` — what was removed and how much free
 * space came back — and, when `DISK_RECLAIM_PING_URL` is set, pings it: success
 * while usage is under `DISK_ALERT_PERCENT`, `/fail` at or over it or when the
 * run itself breaks. That one check is both the job's heartbeat and the
 * full-disk alert, so a job that stops running and a disk that stops shrinking
 * both page.
 *
 * Space freed is measured as the change in the filesystem's free space, not by
 * adding up file sizes: bun hardlinks packages out of its cache, so a
 * directory's apparent size overstates what deleting it returns.
 */
import { appendFile, mkdir, readdir, rm, lstat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileAsync, worktreeExists, toWorktreePath } from '@archon/git';
import { createLogger, getArchonHome } from '@archon/paths';
import * as isolationEnvDb from '../db/isolation-environments';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('disk-reclaim');
  return cachedLog;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Settings read once per run, so a changed `.env` needs only a restart. */
export interface DiskReclaimSettings {
  /** Hours without activity before an environment's packages may go. */
  idleHours: number;
  /** Usage percentage at or above which the run reports failure. */
  alertPercent: number;
  /** Bun cache size above which it is emptied (when the box is quiet). */
  bunCacheMaxBytes: number;
  /** Healthchecks-style ping URL; unset means no ping. */
  pingUrl: string | undefined;
  /** Filesystem to measure — the one holding the workspaces. */
  measurePath: string;
  /** Where the one-line-per-run ledger is appended. */
  ledgerPath: string;
}

export function readDiskReclaimSettings(): DiskReclaimSettings {
  const home = getArchonHome();
  return {
    idleHours: numberFromEnv('DISK_RECLAIM_IDLE_HOURS', 24),
    alertPercent: numberFromEnv('DISK_ALERT_PERCENT', 85),
    bunCacheMaxBytes: 4 * 1024 ** 3,
    pingUrl: process.env.DISK_RECLAIM_PING_URL || undefined,
    measurePath: home,
    ledgerPath: join(home, 'logs', 'disk-reclaim.log'),
  };
}

/** What the running process knows that the database does not. */
export interface DiskReclaimProcessState {
  /** True while a turn holds, or a message waits on, this platform conversation. */
  isConversationBusy(platformConversationId: string): boolean;
  /** True when no conversation in this process holds a turn or has one queued. */
  isProcessQuiet(): boolean;
}

/**
 * Everything the run reads from outside the filesystem. Defaults to the real
 * database; tests pass their own.
 */
export interface DiskReclaimSources {
  listActiveEnvironments(): Promise<
    readonly { id: string; working_path: string; created_at: Date }[]
  >;
  getLiveRunOwningEnv(envId: string): Promise<{ id: string; status: string } | null>;
  getEnvConversationActivity(
    envId: string
  ): Promise<readonly { platform_conversation_id: string; days_idle: number }[]>;
  hasUnfinishedWorkflowRun(): Promise<boolean>;
  /** Absolute bun cache directory, or null when bun cannot say. */
  bunCacheDir(): Promise<string | null>;
  /** Empty the bun cache through bun itself. */
  clearBunCache(): Promise<void>;
}

async function runBunPm(args: string[]): Promise<string> {
  // Asked of bun, from the server's own directory (which has a package.json,
  // which `bun pm` requires), so bunfig and BUN_INSTALL_CACHE_DIR resolve the
  // way bun resolves them rather than by a copy of its rules.
  const { stdout } = await execFileAsync(process.execPath, ['pm', ...args], {
    cwd: process.cwd(),
    timeout: 60_000,
  });
  return stdout.trim();
}

export const databaseSources: DiskReclaimSources = {
  listActiveEnvironments: isolationEnvDb.listAllActiveWithCodebase,
  getLiveRunOwningEnv: isolationEnvDb.getLiveRunOwningEnv,
  getEnvConversationActivity: isolationEnvDb.getEnvConversationActivity,
  hasUnfinishedWorkflowRun: isolationEnvDb.hasUnfinishedWorkflowRun,
  bunCacheDir: async () => {
    const dir = (await runBunPm(['cache'])).split('\n').pop() ?? '';
    return dir.startsWith('/') ? dir : null;
  },
  clearBunCache: async () => {
    await runBunPm(['cache', 'rm']);
  },
};

export interface DiskUsage {
  usedPercent: number;
  availableBytes: number;
  totalBytes: number;
}

/** Usage as `df` reports it: blocks reserved for root count as neither used nor free. */
export async function measureDisk(path: string): Promise<DiskUsage> {
  const s = await statfs(path);
  const used = (s.blocks - s.bfree) * s.bsize;
  const available = s.bavail * s.bsize;
  return {
    usedPercent: Math.round((used / (used + available)) * 1000) / 10,
    availableBytes: available,
    totalBytes: s.blocks * s.bsize,
  };
}

/**
 * Every `node_modules` directory under `root`, outermost only. Does not follow
 * symlinks and does not enter `.git`, so nothing outside the worktree is found.
 */
export async function findNodeModules(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.name === 'node_modules') found.push(full);
      else await walk(full);
    }
  };
  await walk(root);
  return found.sort();
}

/** Apparent size of a tree, symlinks not followed. Used only to size the bun cache. */
async function treeBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await treeBytes(join(path, entry));
  return total;
}

async function hasTrackedNodeModules(worktree: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', worktree, 'ls-files', '--', ':(glob)**/node_modules/**'],
    { timeout: 60_000 }
  );
  return stdout.trim().length > 0;
}

export interface WorktreeReclaim {
  envId: string;
  path: string;
  removed: string[];
  freedBytes: number;
}

export interface DiskReclaimReport {
  startedAt: string;
  before: DiskUsage;
  after: DiskUsage;
  worktrees: WorktreeReclaim[];
  /** Environments left alone because something may still be using them, and why. */
  kept: { envId: string; reason: string }[];
  bunCache: { dir: string; bytes: number; cleared: boolean; reason?: string } | null;
  errors: { envId?: string; error: string }[];
  alert: boolean;
}

/** Why an environment's packages must stay, or null when it is idle. */
async function busyReason(
  env: { id: string; created_at: Date },
  settings: DiskReclaimSettings,
  sources: DiskReclaimSources,
  state: DiskReclaimProcessState
): Promise<string | null> {
  const liveRun = await sources.getLiveRunOwningEnv(env.id);
  if (liveRun) return `run ${liveRun.id.slice(0, 8)} is ${liveRun.status}`;

  const conversations = await sources.getEnvConversationActivity(env.id);
  const busy = conversations.find(c => state.isConversationBusy(c.platform_conversation_id));
  if (busy) return `conversation ${busy.platform_conversation_id} has a turn in flight`;

  const idleDays = conversations.length
    ? Math.min(...conversations.map(c => c.days_idle))
    : (Date.now() - env.created_at.getTime()) / 86_400_000;
  const idleHours = idleDays * 24;
  if (idleHours < settings.idleHours) {
    return `active ${idleHours.toFixed(1)}h ago (< ${String(settings.idleHours)}h)`;
  }
  return null;
}

async function reclaimBunCache(
  settings: DiskReclaimSettings,
  sources: DiskReclaimSources,
  state: DiskReclaimProcessState
): Promise<DiskReclaimReport['bunCache']> {
  const dir = await sources.bunCacheDir();
  if (!dir) return null;
  let bytes: number;
  try {
    bytes = await treeBytes(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { dir, bytes: 0, cleared: false };
    throw err;
  }
  if (bytes <= settings.bunCacheMaxBytes) return { dir, bytes, cleared: false };
  if (!state.isProcessQuiet()) {
    return { dir, bytes, cleared: false, reason: 'a conversation holds a turn' };
  }
  if (await sources.hasUnfinishedWorkflowRun()) {
    return { dir, bytes, cleared: false, reason: 'a workflow run is executing' };
  }
  await sources.clearBunCache();
  return { dir, bytes, cleared: true };
}

async function ping(url: string, fail: boolean, body: string): Promise<void> {
  try {
    const response = await fetch(fail ? `${url.replace(/\/$/, '')}/fail` : url, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      getLog().warn({ status: response.status }, 'disk_reclaim_ping_rejected');
    }
  } catch (err) {
    // The ping is the alert channel; when it cannot be delivered, the missing
    // ping is itself what the check reports once its grace period runs out.
    getLog().warn({ err }, 'disk_reclaim_ping_failed');
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** One pass. Never throws: failures land in the report, the ledger and the ping. */
export async function runDiskReclaim(
  state: DiskReclaimProcessState,
  settings: DiskReclaimSettings = readDiskReclaimSettings(),
  sources: DiskReclaimSources = databaseSources
): Promise<DiskReclaimReport | null> {
  const startedAt = new Date().toISOString();
  try {
    const before = await measureDisk(settings.measurePath);
    const report: DiskReclaimReport = {
      startedAt,
      before,
      after: before,
      worktrees: [],
      kept: [],
      bunCache: null,
      errors: [],
      alert: false,
    };

    for (const env of await sources.listActiveEnvironments()) {
      try {
        if (!(await worktreeExists(toWorktreePath(env.working_path)))) continue;
        // Ownership before the walk: the database answers in milliseconds, the
        // walk of a large worktree does not.
        const reason = await busyReason(env, settings, sources, state);
        if (reason) {
          report.kept.push({ envId: env.id, reason });
          continue;
        }
        const nodeModules = await findNodeModules(env.working_path);
        if (nodeModules.length === 0) continue;
        if (await hasTrackedNodeModules(env.working_path)) {
          report.kept.push({ envId: env.id, reason: 'node_modules is tracked by git' });
          continue;
        }

        const freeBefore = (await measureDisk(settings.measurePath)).availableBytes;
        for (const dir of nodeModules) await rm(dir, { recursive: true, force: true });
        const freeAfter = (await measureDisk(settings.measurePath)).availableBytes;
        report.worktrees.push({
          envId: env.id,
          path: env.working_path,
          removed: nodeModules,
          freedBytes: freeAfter - freeBefore,
        });
      } catch (err) {
        report.errors.push({ envId: env.id, error: (err as Error).message });
      }
    }

    try {
      report.bunCache = await reclaimBunCache(settings, sources, state);
    } catch (err) {
      report.errors.push({ error: `bun cache: ${(err as Error).message}` });
    }

    report.after = await measureDisk(settings.measurePath);
    report.alert = report.after.usedPercent >= settings.alertPercent;

    await mkdir(join(settings.ledgerPath, '..'), { recursive: true });
    await appendFile(settings.ledgerPath, `${JSON.stringify(report)}\n`);

    const freed = report.after.availableBytes - report.before.availableBytes;
    const summary =
      `disk ${String(report.after.usedPercent)}% used (alert at ${String(settings.alertPercent)}%), ` +
      `${formatGiB(report.after.availableBytes)} free; ` +
      `node_modules removed from ${String(report.worktrees.length)} worktree(s); ` +
      `bun cache ${report.bunCache?.cleared ? 'cleared' : 'kept'}; ` +
      `free space changed by ${formatGiB(freed)}; ${String(report.errors.length)} error(s)`;
    const logFields = {
      usedPercent: report.after.usedPercent,
      freedBytes: freed,
      worktrees: report.worktrees.map(w => ({ envId: w.envId, freedBytes: w.freedBytes })),
      kept: report.kept.length,
      bunCache: report.bunCache,
      errors: report.errors,
    };
    if (report.alert) getLog().error(logFields, 'disk_usage_over_alert_threshold');
    else getLog().info(logFields, 'disk_reclaim_completed');

    if (settings.pingUrl) {
      await ping(
        settings.pingUrl,
        report.alert,
        `${summary}\n\n${JSON.stringify(report, null, 2)}`
      );
    }
    return report;
  } catch (err) {
    getLog().error({ err }, 'disk_reclaim_failed');
    if (settings.pingUrl) {
      await ping(settings.pingUrl, true, `disk reclaim failed: ${(err as Error).message}`);
    }
    return null;
  }
}

const INTERVAL_MS = 60 * 60 * 1000;
let intervalId: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/**
 * Run once now and then hourly. Hourly, not with the six-hourly worktree
 * cleanup, because the alert must fire before the disk fills, and the ping's
 * grace period is measured against this cadence.
 */
export function startDiskReclaimScheduler(state: DiskReclaimProcessState): void {
  if (intervalId) return;
  let settings: DiskReclaimSettings;
  try {
    settings = readDiskReclaimSettings();
  } catch (err) {
    // A malformed threshold must not become a silent default.
    getLog().error({ err }, 'disk_reclaim_misconfigured');
    return;
  }
  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    void runDiskReclaim(state, settings).finally(() => {
      inFlight = false;
    });
  };
  tick();
  intervalId = setInterval(tick, INTERVAL_MS);
  getLog().info(
    {
      idleHours: settings.idleHours,
      alertPercent: settings.alertPercent,
      ping: !!settings.pingUrl,
    },
    'disk_reclaim_scheduler_started'
  );
}

export function stopDiskReclaimScheduler(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}
