/**
 * A project's deploy controls (#211): its Live commit, the Deploy on Merge
 * switch, what has merged but is not yet live, and the three actions.
 *
 * The routes are plain `app.get`/`app.patch` handlers on the server, so they
 * are not in the generated OpenAPI types. The shape is declared here and read
 * defensively, the same way `activeChats` reads the health fields the schema
 * does not pin: a malformed answer yields no deploy row rather than a crash.
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

export interface ProjectDeploy {
  deployOnMerge: boolean;
  branch: string;
  live: { sha: string | null; deployedAt: string | null };
  /** Null when nothing is waiting — or when it could not be read; `waitingReason` says which. */
  waiting: DeployWaiting | null;
  waitingReason: string | null;
  status: DeployStatus;
  cancellable: boolean;
  running: { chats: number; workflows: number };
  /** False when this request carried no verified Cloudflare Access pass; every action will be refused. */
  canAct: boolean;
}

export type DeployLogKind =
  | 'toggle_on'
  | 'toggle_off'
  | 'deploy_requested'
  | 'deploy_cancelled'
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

/**
 * Read the `deploy` field of the GET answer. Null for a project with no deploy,
 * and null for an answer this build cannot read — both draw no row. A status
 * whose phase this build does not know counts as unreadable, for the reason
 * `parseDeploy` gives.
 */
export function parseProjectDeploy(raw: unknown): ProjectDeploy | null {
  if (!isRecord(raw) || typeof raw.deployOnMerge !== 'boolean') return null;
  const status = parseDeploy(raw.status);
  if (status === undefined) return null;
  const live = isRecord(raw.live) ? raw.live : {};
  const running = isRecord(raw.running) ? raw.running : {};
  return {
    deployOnMerge: raw.deployOnMerge,
    branch: typeof raw.branch === 'string' ? raw.branch : '',
    live: { sha: nullableString(live.sha), deployedAt: nullableString(live.deployedAt) },
    waiting: parseWaiting(raw.waiting),
    waitingReason: nullableString(raw.waitingReason),
    status,
    cancellable: raw.cancellable === true,
    running: { chats: count(running.chats), workflows: count(running.workflows) },
    canAct: raw.canAct === true,
  };
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

export async function getProjectDeploy(projectId: string): Promise<ProjectDeploy | null> {
  const res = await requestJson<{ deploy?: unknown }>(deployPath(projectId));
  return parseProjectDeploy(res.deploy);
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
