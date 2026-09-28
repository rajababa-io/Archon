/**
 * Deploys for a project whose repository says how it deploys (#226): the
 * `workflow` method. The deploy IS an Archon workflow in that repository
 * (`.archon/workflows/deploy.yaml` by default); Archon runs it and tracks the
 * run, and knows nothing about where the project runs.
 *
 * A deploy starts through the engine's resource-start path — the one scheduled
 * and webhook-triggered runs take — so it needs no chat to hang from. Each
 * project's deploys hold their own resource slot (`deploy:<project id>`), so a
 * second deploy of the same project is skipped while one runs and another
 * project's deploy is never in the way.
 *
 * Every function here acts on the one project it is handed. Cancel and the log
 * read only that project's rows in `remote_agent_deploy_runs`; nothing here
 * touches the Archon host deploy.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getDefaultBranch, toRepoPath } from '@archon/git';
import { createLogger } from '@archon/paths';
import { loadConfig, type Codebase } from '@archon/core';
import * as codebaseDb from '@archon/core/db/codebases';
import * as projectDeployDb from '@archon/core/db/project-deploy';
import type { DeployRun, WorkflowProjectDeploy } from '@archon/core/db/project-deploy';
import { acceptStartReceipt, getStartReceipt } from '@archon/core/db/resource-starts';
import * as userDb from '@archon/core/db/users';
import { CancelRefusedError, cancelWorkflow } from '@archon/core/operations/workflow-operations';
import type { BranchMerged } from '@archon/core/services/branch-merged';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { githubRepoOf } from '../routes/github-issues';
import {
  type DeployLogEntry,
  type Waiting,
  readWaiting,
  resetWaitingCache,
} from './deploy-control';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow-deploy');
  return cachedLog;
}

/**
 * The server as the host that starts deploy runs. Null when the operator named
 * no `ARCHON_TRIGGER_HOST`: the server then drains no resource starts, so a
 * deploy accepted here would never run.
 */
export interface DeployHost {
  hostId: string;
  /** True while this server drains for its own replacement; it starts nothing then. */
  isDraining: () => boolean;
  /** Resolves when a host pass covering everything accepted so far has ended. */
  requestDrain: () => Promise<void>;
}

/** Why Deploy now cannot run, as the bar names it. */
export type DeployBlocked = 'no-trigger-host' | 'restarting' | 'workflow-missing';

const ACTIVE: readonly DeployRun['status'][] = ['pending', 'running', 'paused'];

// ─── Setting up ──────────────────────────────────────────────────────────────

/**
 * The workflows a project could deploy with. Archon's bundled workflows are left
 * out: none of them deploys anything, and a deploy is the repository's own.
 */
export async function listDeployableWorkflows(codebase: Codebase): Promise<string[]> {
  const { workflows } = await discoverWorkflowsWithConfig(codebase.default_cwd, loadConfig);
  return workflows
    .filter(w => w.source !== 'bundled')
    .map(w => w.workflow.name)
    .sort();
}

export interface DeploySetup {
  /** Null when neither the project nor its checkout names a default branch. */
  branch: string | null;
  workflows: string[];
  /** `deploy` when the project has one; otherwise the person picks. */
  workflow: string | null;
}

/** What the Set up deploys picker starts filled with. */
export async function readDeploySetup(codebase: Codebase): Promise<DeploySetup> {
  const [workflows, branch] = await Promise.all([
    listDeployableWorkflows(codebase),
    defaultBranchOf(codebase),
  ]);
  return { branch, workflows, workflow: workflows.includes('deploy') ? 'deploy' : null };
}

async function defaultBranchOf(codebase: Codebase): Promise<string | null> {
  const stored = codebase.default_branch?.trim();
  if (stored) return stored;
  try {
    return await getDefaultBranch(toRepoPath(codebase.default_cwd));
  } catch (err) {
    // `getDefaultBranch` refuses to guess when origin/HEAD is unset. The picker
    // then starts empty and the person types the branch; nothing is deployed
    // on the strength of a guess.
    getLog().debug({ err, codebaseId: codebase.id }, 'deploy.default_branch_unknown');
    return null;
  }
}

// ─── The view the header draws ───────────────────────────────────────────────

export interface WorkflowDeployView {
  method: 'workflow';
  workflowName: string;
  deployOnMerge: boolean;
  branch: string;
  /** The commit of the newest deploy run that completed. Null before the first. */
  live: { sha: string | null; deployedAt: string | null };
  waiting: Waiting | null;
  waitingReason: string | null;
  /** The deploy run in flight, if any. */
  run: { id: string; sha: string; status: DeployRun['status']; startedAt: string } | null;
  /** Cancel can stop only a run that is executing. */
  cancellable: boolean;
  blocked: DeployBlocked | null;
}

async function blockerFor(
  codebase: Codebase,
  setting: WorkflowProjectDeploy,
  host: DeployHost | null
): Promise<DeployBlocked | null> {
  if (host === null) return 'no-trigger-host';
  if (host.isDraining()) return 'restarting';
  const workflows = await listDeployableWorkflows(codebase);
  return workflows.includes(setting.workflowName) ? null : 'workflow-missing';
}

export async function getWorkflowDeployView(
  codebase: Codebase,
  setting: WorkflowProjectDeploy,
  host: DeployHost | null
): Promise<WorkflowDeployView> {
  const [runs, blocked] = await Promise.all([
    projectDeployDb.listDeployRuns(codebase.id),
    blockerFor(codebase, setting, host),
  ]);
  const live = runs.find(r => r.status === 'completed');
  const active = runs.find(r => ACTIVE.includes(r.status));
  const { waiting, reason } = await readWaiting(codebase, setting.branch, live?.sha ?? null);
  // Nothing new since the live commit reads as up to date. Before the first
  // deploy there is no live commit, so whatever the branch holds is waiting.
  const nothingNew =
    live !== undefined && waiting !== null && waiting.prs.length === 0 && !waiting.more;
  return {
    method: 'workflow',
    workflowName: setting.workflowName,
    deployOnMerge: setting.deployOnMerge,
    branch: setting.branch,
    live: { sha: live?.sha ?? null, deployedAt: live?.finishedAt ?? null },
    waiting: nothingNew ? null : waiting,
    waitingReason: reason,
    run:
      active === undefined
        ? null
        : { id: active.runId, sha: active.sha, status: active.status, startedAt: active.at },
    cancellable: active?.status === 'running',
    blocked,
  };
}

// ─── Starting a deploy ───────────────────────────────────────────────────────

export type StartDeployResult =
  | { ok: true; runId: string }
  | { ok: false; status: 409 | 500 | 503; error: string };

const BLOCKED_TEXT: Record<DeployBlocked, string> = {
  'no-trigger-host':
    'This server starts no workflow runs on its own: set ARCHON_TRIGGER_HOST to deploy with a workflow.',
  restarting: 'Archon is restarting. Deploy again once it is back.',
  'workflow-missing': 'The deploy workflow is not in this project.',
};

export function blockedText(blocked: DeployBlocked, workflowName: string): string {
  return blocked === 'workflow-missing'
    ? `This project has no workflow named "${workflowName}".`
    : BLOCKED_TEXT[blocked];
}

interface StartRequest {
  codebase: Codebase;
  setting: WorkflowProjectDeploy;
  sha: string;
  runAsUserId: string;
  /** Who or what asked: recorded on the receipt, beside the run. */
  actor: { source: 'console' | 'github'; id: string };
  /**
   * The same deploy asked for twice — a redelivered merge — carries the same
   * key and starts once. Null when every request is its own.
   */
  deliveryKey: string | null;
}

/**
 * Start the project's deploy workflow on a checkout cut from the tip of the
 * row's branch, and record the run as this project's deploy of `sha`.
 *
 * Waits for the host pass that prepares it, because only then is there a run to
 * record — and a refusal (a deploy already running, a workflow that will not
 * load) is something the person pressing the button needs to hear.
 */
export async function startWorkflowDeploy(
  request: StartRequest,
  host: DeployHost | null
): Promise<StartDeployResult> {
  const { codebase, setting, sha } = request;
  const blocked = await blockerFor(codebase, setting, host);
  if (blocked !== null || host === null) {
    return {
      ok: false,
      status: 409,
      error: blockedText(blocked ?? 'no-trigger-host', setting.workflowName),
    };
  }
  const runs = await projectDeployDb.listDeployRuns(codebase.id, 10);
  if (runs.some(r => ACTIVE.includes(r.status))) {
    return { ok: false, status: 409, error: 'A deploy of this project is already running.' };
  }

  const receiptId = randomUUID();
  const accepted = await acceptStartReceipt({
    receipt: {
      id: receiptId,
      sourceInstanceId: `deploy:${codebase.id}`,
      deliveryId: request.deliveryKey,
      contentDigest: createHash('sha256').update(`${codebase.id}:${sha}`).digest('hex'),
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: { source: request.actor.source, id: request.actor.id },
    },
    outcome: 'matched',
    bindings: [
      {
        bindingId: 'deploy',
        bindingRevision: null,
        hostId: host.hostId,
        runAsUserId: request.runAsUserId,
        resource: `deploy:${codebase.id}`,
        capacity: 1,
        overlap: 'skip',
        launch: {
          cwd: codebase.default_cwd,
          workflowName: setting.workflowName,
          inputs: {},
          isolation: { kind: 'worktree', baseOverride: setting.branch },
        },
      },
    ],
  });
  if (accepted.replay) {
    getLog().info({ codebaseId: codebase.id, key: request.deliveryKey }, 'deploy.replay_ignored');
    return { ok: false, status: 409, error: 'This deploy was already requested.' };
  }

  await host.requestDrain();
  const binding = (await getStartReceipt(receiptId))?.bindings[0];
  const disposition = binding?.disposition;
  if (disposition?.status === 'admitted') {
    await projectDeployDb.recordDeployRun(codebase.id, disposition.runId, sha);
    resetWaitingCache();
    getLog().info(
      { codebaseId: codebase.id, runId: disposition.runId, sha, by: request.actor },
      'deploy.workflow_started'
    );
    return { ok: true, runId: disposition.runId };
  }
  if (disposition?.status === 'skipped') {
    return { ok: false, status: 409, error: 'A deploy of this project is already running.' };
  }
  if (binding?.status === 'failed' || binding?.status === 'rejected') {
    // The stage name is all the receipt keeps — the cause can carry secrets —
    // and the drain has already logged the cause itself.
    return {
      ok: false,
      status: 500,
      error: `The deploy workflow could not be started (${binding.error ?? 'unknown'}). The server log has the cause.`,
    };
  }
  getLog().warn(
    { codebaseId: codebase.id, receiptId, binding: binding?.status },
    'deploy.accepted_not_started'
  );
  return {
    ok: false,
    status: 503,
    error: `The deploy was accepted but has not started. Inspect it with: archon trigger inspect ${receiptId}`,
  };
}

/** The Archon user a deploy runs as, from the email a person signed in with. */
async function userForEmail(email: string): Promise<string> {
  return (await userDb.findOrCreateUserByPlatformIdentity('web', email, email)).id;
}

/** Deploy now, pressed by a person, for the tip they were shown. */
export async function deployWorkflowNow(
  codebase: Codebase,
  setting: WorkflowProjectDeploy,
  expectSha: string,
  email: string,
  host: DeployHost | null
): Promise<StartDeployResult> {
  resetWaitingCache();
  const runs = await projectDeployDb.listDeployRuns(codebase.id, 10);
  const liveSha = runs.find(r => r.status === 'completed')?.sha ?? null;
  const { waiting, reason } = await readWaiting(codebase, setting.branch, liveSha);
  if (waiting === null) {
    return {
      ok: false,
      status: 409,
      error: `Could not read the tip of ${setting.branch} (${reason ?? 'unknown'}).`,
    };
  }
  if (waiting.tipSha !== expectSha) {
    return {
      ok: false,
      status: 409,
      error: `${setting.branch} moved since you looked. Refresh and try again.`,
    };
  }
  const result = await startWorkflowDeploy(
    {
      codebase,
      setting,
      sha: expectSha,
      runAsUserId: await userForEmail(email),
      actor: { source: 'console', id: email },
      deliveryKey: null,
    },
    host
  );
  if (result.ok) {
    await projectDeployDb.recordDeployEvent(codebase.id, 'deploy_requested', email, expectSha);
  }
  return result;
}

/** Whether the merge happened in the repository this project was cloned from. */
function isMergedRepo(codebase: Codebase, signal: BranchMerged): boolean {
  const repo = codebase.repository_url ? githubRepoOf(codebase.repository_url) : null;
  return (
    repo?.owner.toLowerCase() === signal.repo.owner.toLowerCase() &&
    repo.repo.toLowerCase() === signal.repo.name.toLowerCase()
  );
}

/**
 * A merge landed. Every project whose deploy follows that repository's branch
 * with Deploy on Merge on starts its deploy; a project with the switch off is
 * not even read, so it records nothing.
 */
export async function deployMergedBranch(
  signal: BranchMerged,
  host: DeployHost | null
): Promise<void> {
  const settings = await projectDeployDb.listMergeDeploysOnBranch(signal.branch);
  for (const setting of settings) {
    const codebase = await codebaseDb.getCodebase(setting.codebaseId);
    if (codebase === null || !isMergedRepo(codebase, signal)) continue;
    // A merge has no person behind it. The deploy runs as whoever last set the
    // switch, which is the person who decided merges should ship on their own.
    if (setting.updatedBy === null) {
      getLog().warn({ codebaseId: codebase.id }, 'deploy.merge_without_owner');
      continue;
    }
    const result = await startWorkflowDeploy(
      {
        codebase,
        setting,
        sha: signal.sha,
        runAsUserId: await userForEmail(setting.updatedBy),
        actor: {
          source: 'github',
          id: `${signal.repo.owner}/${signal.repo.name}#${String(signal.pr)}`,
        },
        deliveryKey: `${signal.repo.owner}/${signal.repo.name}#${String(signal.pr)}`,
      },
      host
    );
    if (!result.ok) {
      getLog().warn(
        { codebaseId: codebase.id, pr: signal.pr, sha: signal.sha, error: result.error },
        'deploy.merge_not_started'
      );
    }
  }
}

// ─── Cancel deploy ───────────────────────────────────────────────────────────

export type CancelWorkflowDeployResult =
  | { ok: true; runId: string }
  | { ok: false; status: 409; error: string };

/** Cancel this project's deploy run. Another project's runs are never looked at. */
export async function cancelWorkflowDeploy(
  codebaseId: string,
  actor: string
): Promise<CancelWorkflowDeployResult> {
  const runs = await projectDeployDb.listDeployRuns(codebaseId, 10);
  const active = runs.find(r => ACTIVE.includes(r.status));
  if (active === undefined) return { ok: false, status: 409, error: 'No deploy is running.' };
  try {
    await cancelWorkflow(active.runId);
  } catch (error) {
    if (error instanceof CancelRefusedError) {
      return { ok: false, status: 409, error: error.message };
    }
    throw error;
  }
  await projectDeployDb.recordDeployEvent(codebaseId, 'deploy_cancelled', actor, active.sha);
  return { ok: true, runId: active.runId };
}

// ─── The log on the Overview tab ─────────────────────────────────────────────

const VERDICT: Partial<Record<DeployRun['status'], DeployLogEntry['kind']>> = {
  completed: 'ok',
  failed: 'failed',
  cancelled: 'killed',
};

/** The console's actions merged with each deploy run's start and verdict, newest first. */
export async function getWorkflowDeployLog(
  codebaseId: string,
  limit = 50
): Promise<DeployLogEntry[]> {
  const [events, runs] = await Promise.all([
    projectDeployDb.listDeployEvents(codebaseId, limit),
    projectDeployDb.listDeployRuns(codebaseId, limit),
  ]);
  const entries: DeployLogEntry[] = events.map(e => ({
    at: e.at,
    kind: e.kind,
    actor: e.actor,
    sha: e.sha,
    detail: null,
  }));
  for (const run of runs) {
    entries.push({ at: run.at, kind: 'started', actor: null, sha: run.sha, detail: run.runId });
    const verdict = VERDICT[run.status];
    if (verdict !== undefined && run.finishedAt !== null) {
      entries.push({
        at: run.finishedAt,
        kind: verdict,
        actor: null,
        sha: run.sha,
        detail: run.runId,
      });
    }
  }
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}
