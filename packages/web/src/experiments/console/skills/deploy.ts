/**
 * A project's deploy controls (#211, #226): its Live commit, the Deploy on
 * Merge switch, what has merged but is not yet live, and the three actions —
 * or, for a project with no deploy, what Set up deploys starts filled with.
 *
 * The routes are plain `app.get`/`app.patch` handlers on the server, so they
 * are not in the generated OpenAPI types. The shape is declared here and read
 * defensively, the same way `activeChats` reads the health fields the schema
 * does not pin: a malformed answer yields no deploy bar rather than a crash.
 * The embedded `status` IS pinned — it is the health route's deploy block —
 * so it is parsed by that module's parser rather than a second copy.
 */
import { requestJson } from '../lib/http';
import { parseDeploy, type DeployStatus } from './activeChats';

export interface WaitingPr {
  number: number;
  title: string;
  url: string;
}

export interface DeployWaiting {
  /** The branch tip Deploy now ships. Sent back so a branch that moved is refused, not shipped. */
  tipSha: string;
  /** Newest first. */
  prs: readonly WaitingPr[];
  /** The server capped the list; there are more than `prs` holds. */
  more: boolean;
}

interface DeployCommon {
  deployOnMerge: boolean;
  branch: string;
  live: { sha: string | null; deployedAt: string | null };
  /** Null when nothing is waiting — or when it could not be read; `waitingReason` says which. */
  waiting: DeployWaiting | null;
  waitingReason: string | null;
  cancellable: boolean;
  /** False when this request carried no verified Cloudflare Access pass; every action will be refused. */
  canAct: boolean;
}

/** This Archon install deploying itself: the host's request file, drain and swap. */
export interface HostDeploy extends DeployCommon {
  method: 'archon-host';
  status: DeployStatus;
  running: { chats: number; workflows: number };
}

export type DeployRunStatus = 'pending' | 'running' | 'paused';

/** Why Deploy now cannot run. */
export type DeployBlocked = 'no-trigger-host' | 'restarting' | 'workflow-missing';

/** A project whose repository deploys it with one of its own workflows. */
export interface WorkflowDeploy extends DeployCommon {
  method: 'workflow';
  workflowName: string;
  /** The deploy run in flight. */
  run: { id: string; sha: string; status: DeployRunStatus; startedAt: string } | null;
  blocked: DeployBlocked | null;
}

export type ProjectDeploy = HostDeploy | WorkflowDeploy;

/** What the Set up deploys picker starts filled with. */
export interface DeploySetup {
  branch: string | null;
  workflows: readonly string[];
  workflow: string | null;
}

/** The GET answer: a deploy, or none yet and how to set one up. */
export type DeployAnswer =
  | { kind: 'set-up'; deploy: ProjectDeploy }
  | { kind: 'not-set-up'; setup: DeploySetup; canAct: boolean };

export type DeployLogKind =
  | 'toggle_on'
  | 'toggle_off'
  | 'deploy_requested'
  | 'deploy_cancelled'
  | 'started'
  | 'held'
  | 'ok'
  | 'failed'
  | 'refused'
  | 'killed';

export interface DeployLogEntry {
  at: string;
  kind: DeployLogKind;
  actor: string | null;
  sha: string | null;
  detail: string | null;
}

const LOG_KINDS: readonly DeployLogKind[] = [
  'toggle_on',
  'toggle_off',
  'deploy_requested',
  'deploy_cancelled',
  'started',
  'held',
  'ok',
  'failed',
  'refused',
  'killed',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function parseWaiting(raw: unknown): DeployWaiting | null {
  if (!isRecord(raw) || typeof raw.tipSha !== 'string' || raw.tipSha === '') return null;
  const prs: WaitingPr[] = [];
  if (Array.isArray(raw.prs)) {
    for (const pr of raw.prs as unknown[]) {
      if (!isRecord(pr)) continue;
      const { number, title, url } = pr;
      if (typeof number !== 'number' || typeof title !== 'string' || typeof url !== 'string') {
        continue;
      }
      prs.push({ number, title, url });
    }
  }
  return { tipSha: raw.tipSha, prs, more: raw.more === true };
}

const RUN_STATUSES: readonly DeployRunStatus[] = ['pending', 'running', 'paused'];
const BLOCKED: readonly DeployBlocked[] = ['no-trigger-host', 'restarting', 'workflow-missing'];

function parseRun(raw: unknown): WorkflowDeploy['run'] {
  if (!isRecord(raw)) return null;
  const { id, sha, status, startedAt } = raw;
  if (
    typeof id !== 'string' ||
    typeof sha !== 'string' ||
    typeof startedAt !== 'string' ||
    !RUN_STATUSES.includes(status as DeployRunStatus)
  ) {
    return null;
  }
  return { id, sha, status: status as DeployRunStatus, startedAt };
}

/**
 * Read the `deploy` field of the GET answer. Null for an answer this build
 * cannot read, which draws no bar. A method this build does not know is
 * unreadable, and so is a host status whose phase it does not know, for the
 * reason `parseDeploy` gives.
 */
export function parseProjectDeploy(raw: unknown): ProjectDeploy | null {
  if (!isRecord(raw) || typeof raw.deployOnMerge !== 'boolean') return null;
  const live = isRecord(raw.live) ? raw.live : {};
  const common: DeployCommon = {
    deployOnMerge: raw.deployOnMerge,
    branch: typeof raw.branch === 'string' ? raw.branch : '',
    live: { sha: nullableString(live.sha), deployedAt: nullableString(live.deployedAt) },
    waiting: parseWaiting(raw.waiting),
    waitingReason: nullableString(raw.waitingReason),
    cancellable: raw.cancellable === true,
    canAct: raw.canAct === true,
  };
  if (raw.method === 'workflow') {
    if (typeof raw.workflowName !== 'string') return null;
    return {
      ...common,
      method: 'workflow',
      workflowName: raw.workflowName,
      run: parseRun(raw.run),
      blocked: BLOCKED.includes(raw.blocked as DeployBlocked)
        ? (raw.blocked as DeployBlocked)
        : null,
    };
  }
  if (raw.method !== 'archon-host') return null;
  const status = parseDeploy(raw.status);
  if (status === undefined) return null;
  const running = isRecord(raw.running) ? raw.running : {};
  return {
    ...common,
    method: 'archon-host',
    status,
    running: { chats: count(running.chats), workflows: count(running.workflows) },
  };
}

function parseSetup(raw: unknown): DeploySetup {
  const setup = isRecord(raw) ? raw : {};
  const workflows = Array.isArray(setup.workflows)
    ? (setup.workflows as unknown[]).filter((w): w is string => typeof w === 'string')
    : [];
  const workflow = nullableString(setup.workflow);
  return {
    branch: nullableString(setup.branch),
    workflows,
    workflow: workflow !== null && workflows.includes(workflow) ? workflow : null,
  };
}

/** Read the whole GET answer. Null when it is neither a deploy nor the no-deploy answer. */
export function parseDeployAnswer(raw: unknown): DeployAnswer | null {
  if (!isRecord(raw)) return null;
  if (raw.deploy === null) {
    return { kind: 'not-set-up', setup: parseSetup(raw.setup), canAct: raw.canAct === true };
  }
  const deploy = parseProjectDeploy(raw.deploy);
  return deploy === null ? null : { kind: 'set-up', deploy };
}

export function parseDeployLog(raw: unknown): DeployLogEntry[] {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return [];
  const out: DeployLogEntry[] = [];
  for (const entry of raw.entries as unknown[]) {
    if (!isRecord(entry) || typeof entry.at !== 'string') continue;
    const kind = entry.kind;
    if (typeof kind !== 'string' || !LOG_KINDS.includes(kind as DeployLogKind)) continue;
    out.push({
      at: entry.at,
      kind: kind as DeployLogKind,
      actor: nullableString(entry.actor),
      sha: nullableString(entry.sha),
      detail: nullableString(entry.detail),
    });
  }
  return out;
}

function deployPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/deploy`;
}

export async function getProjectDeploy(projectId: string): Promise<DeployAnswer | null> {
  return parseDeployAnswer(await requestJson<unknown>(deployPath(projectId)));
}

/** Set up deploys: the row starts with Deploy on Merge off, and nothing deploys. */
export async function setUpDeploy(
  projectId: string,
  branch: string,
  workflowName: string
): Promise<void> {
  await requestJson(deployPath(projectId), {
    method: 'PUT',
    body: JSON.stringify({ branch, workflowName }),
  });
}

export async function setDeployOnMerge(projectId: string, on: boolean): Promise<boolean> {
  const res = await requestJson<{ deployOnMerge?: unknown }>(deployPath(projectId), {
    method: 'PATCH',
    body: JSON.stringify({ deployOnMerge: on }),
  });
  return res.deployOnMerge === true;
}

/** Ship `sha`, the waiting tip the row showed. The server refuses it if the branch has since moved. */
export async function deployNow(projectId: string, sha: string): Promise<void> {
  await requestJson(deployPath(projectId), {
    method: 'POST',
    body: JSON.stringify({ sha }),
  });
}

export async function cancelProjectDeploy(projectId: string): Promise<void> {
  await requestJson(deployPath(projectId), { method: 'DELETE' });
}

export async function getProjectDeployLog(projectId: string): Promise<DeployLogEntry[]> {
  const res = await requestJson<unknown>(`${deployPath(projectId)}/log`);
  return parseDeployLog(res);
}
