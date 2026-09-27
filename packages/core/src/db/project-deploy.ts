/**
 * How a project deploys, whether merges deploy on their own, and the deploy
 * actions a person took in the console (#211).
 *
 * THE SETTING IS A PERSON'S. `deploy_on_merge` is written only by the console's
 * human-verified routes, never by an agent tool. Nothing here enforces that —
 * the route does, because only the route can see who is asking — but nothing in
 * `orchestrator/` may import the setters either.
 *
 * The deploy's own verdicts (held, OK, failed, killed) are not stored here. The
 * host writes them to `deploy-history`, and the Overview log merges that file
 * with these rows at read time.
 */
import { createLogger } from '@archon/paths';

import { pool, getDialect } from './connection';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.project-deploy');
  return cachedLog;
}

/**
 * The deploy methods this binary knows how to drive. A row naming anything else
 * was written by a newer binary; it is read as "no deploy" rather than guessed.
 *
 * - `archon-host`: this install itself — `scripts/request-deploy.sh` writes a
 *   request file and the host's `deploy-on-request.sh` acts on it.
 */
export const DEPLOY_METHODS = ['archon-host'] as const;
export type DeployMethod = (typeof DEPLOY_METHODS)[number];

function isDeployMethod(value: string): value is DeployMethod {
  return (DEPLOY_METHODS as readonly string[]).includes(value);
}

export interface ProjectDeploy {
  codebaseId: string;
  method: DeployMethod;
  /** The branch merges land on; what "merged but not live" is measured along. */
  branch: string;
  deployOnMerge: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

interface ProjectDeployRow {
  codebase_id: string;
  method: string;
  branch: string;
  // Postgres answers a boolean, SQLite an integer.
  deploy_on_merge: boolean | number;
  updated_at: string | Date;
  updated_by: string | null;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toProjectDeploy(row: ProjectDeployRow): ProjectDeploy | null {
  if (!isDeployMethod(row.method)) {
    getLog().warn({ codebaseId: row.codebase_id, method: row.method }, 'deploy.unknown_method');
    return null;
  }
  return {
    codebaseId: row.codebase_id,
    method: row.method,
    branch: row.branch,
    deployOnMerge: row.deploy_on_merge === true || row.deploy_on_merge === 1,
    updatedAt: iso(row.updated_at),
    updatedBy: row.updated_by,
  };
}

const SELECT = `SELECT codebase_id, method, branch, deploy_on_merge, updated_at, updated_by
  FROM remote_agent_project_deploy`;

/** Null means the project has no deploy, or one this binary cannot drive. */
export async function getProjectDeploy(codebaseId: string): Promise<ProjectDeploy | null> {
  const res = await pool.query<ProjectDeployRow>(`${SELECT} WHERE codebase_id = $1`, [codebaseId]);
  const row = res.rows[0];
  return row === undefined ? null : toProjectDeploy(row);
}

/**
 * The project a method belongs to. `archon-host` is this install, so at most one
 * project should carry it; if two do, the oldest setting wins and the conflict is
 * logged rather than resolved by picking silently.
 */
export async function findProjectDeployByMethod(
  method: DeployMethod
): Promise<ProjectDeploy | null> {
  const res = await pool.query<ProjectDeployRow>(
    `${SELECT} WHERE method = $1 ORDER BY updated_at ASC`,
    [method]
  );
  if (res.rows.length > 1) {
    getLog().warn(
      { method, codebaseIds: res.rows.map(r => r.codebase_id) },
      'deploy.method_claimed_twice'
    );
  }
  const row = res.rows[0];
  return row === undefined ? null : toProjectDeploy(row);
}

/**
 * Give a project a deploy. Starts with `deploy_on_merge` off: a project gains the
 * ability to deploy before anyone has decided merges should ship on their own.
 */
export async function createProjectDeploy(
  codebaseId: string,
  method: DeployMethod,
  branch: string
): Promise<void> {
  await pool.query(
    `INSERT INTO remote_agent_project_deploy (codebase_id, method, branch, deploy_on_merge, updated_at)
     VALUES ($1, $2, $3, $4, ${getDialect().now()})`,
    [codebaseId, method, branch, false]
  );
}

/** Flip the setting. Returns the value it was before, so the caller can log from/to. */
export async function setDeployOnMerge(
  codebaseId: string,
  deployOnMerge: boolean,
  actor: string
): Promise<{ before: boolean; after: ProjectDeploy } | null> {
  const current = await getProjectDeploy(codebaseId);
  if (current === null) return null;
  await pool.query(
    `UPDATE remote_agent_project_deploy
       SET deploy_on_merge = $1, updated_at = ${getDialect().now()}, updated_by = $2
     WHERE codebase_id = $3`,
    [deployOnMerge, actor, codebaseId]
  );
  await recordDeployEvent(codebaseId, deployOnMerge ? 'toggle_on' : 'toggle_off', actor, null);
  const after = await getProjectDeploy(codebaseId);
  if (after === null) return null;
  return { before: current.deployOnMerge, after };
}

export const DEPLOY_EVENT_KINDS = [
  'toggle_on',
  'toggle_off',
  'deploy_requested',
  'deploy_cancelled',
] as const;
export type DeployEventKind = (typeof DEPLOY_EVENT_KINDS)[number];

export interface DeployEvent {
  id: string;
  codebaseId: string;
  kind: DeployEventKind;
  actor: string | null;
  sha: string | null;
  at: string;
}

interface DeployEventRow {
  id: string;
  codebase_id: string;
  kind: DeployEventKind;
  actor: string | null;
  sha: string | null;
  created_at: string | Date;
}

/** Returns the new row's id — for `deploy_requested`, the token the host checks. */
export async function recordDeployEvent(
  codebaseId: string,
  kind: DeployEventKind,
  actor: string | null,
  sha: string | null
): Promise<string> {
  const dialect = getDialect();
  const id = dialect.generateUuid();
  await pool.query(
    `INSERT INTO remote_agent_deploy_events (id, codebase_id, kind, actor, sha, created_at)
     VALUES ($1, $2, $3, $4, $5, ${dialect.now()})`,
    [id, codebaseId, kind, actor, sha]
  );
  return id;
}

/** Newest first. */
export async function listDeployEvents(codebaseId: string, limit = 50): Promise<DeployEvent[]> {
  const res = await pool.query<DeployEventRow>(
    `SELECT id, codebase_id, kind, actor, sha, created_at
       FROM remote_agent_deploy_events
      WHERE codebase_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [codebaseId, limit]
  );
  return res.rows.map(row => ({
    id: row.id,
    codebaseId: row.codebase_id,
    kind: row.kind,
    actor: row.actor,
    sha: row.sha,
    at: iso(row.created_at),
  }));
}

/**
 * Whether a manual request's token was issued by the console for this commit.
 *
 * The request file lives on a volume any process in the container can write, so
 * "manual" written into it proves nothing. What proves a person pressed Deploy
 * now is a `deploy_requested` row, which only the human-verified route inserts.
 */
export async function isIssuedManualRequest(requestId: string, sha: string): Promise<boolean> {
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM remote_agent_deploy_events
      WHERE id = $1 AND kind = 'deploy_requested' AND sha = $2`,
    [requestId, sha]
  );
  return res.rows.length > 0;
}
