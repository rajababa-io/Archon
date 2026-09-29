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
 *
 * What needs no database — the stored event kinds, the deploy pointer — is in
 * `project-deploy-rules.ts`, so a caller that mocks this module still gets it.
 */
import { createLogger } from '@archon/paths';

import {
  workflowRunStatusSchema,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';

import { pool, getDialect } from './connection';
import type { DeployEventKind } from './project-deploy-rules';

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
 *   request file and the host's `deploy-on-request.sh` acts on it. At most one
 *   project carries it; no route creates it.
 * - `workflow`: the project's own repository says how it deploys, as an Archon
 *   workflow (`workflow_name`). Archon only runs that workflow and tracks the run.
 */
export const DEPLOY_METHODS = ['archon-host', 'workflow'] as const;
export type DeployMethod = (typeof DEPLOY_METHODS)[number];

function isDeployMethod(value: string): value is DeployMethod {
  return (DEPLOY_METHODS as readonly string[]).includes(value);
}

interface ProjectDeployBase {
  codebaseId: string;
  /** The branch merges land on; what "merged but not live" is measured along. */
  branch: string;
  deployOnMerge: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export type WorkflowProjectDeploy = ProjectDeployBase & {
  method: 'workflow';
  workflowName: string;
};
export type ProjectDeploy = (ProjectDeployBase & { method: 'archon-host' }) | WorkflowProjectDeploy;

interface ProjectDeployRow {
  codebase_id: string;
  method: string;
  branch: string;
  // Postgres answers a boolean, SQLite an integer.
  deploy_on_merge: boolean | number;
  updated_at: string | Date;
  updated_by: string | null;
  workflow_name: string | null;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toProjectDeploy(row: ProjectDeployRow): ProjectDeploy | null {
  if (!isDeployMethod(row.method)) {
    getLog().warn({ codebaseId: row.codebase_id, method: row.method }, 'deploy.unknown_method');
    return null;
  }
  const base: ProjectDeployBase = {
    codebaseId: row.codebase_id,
    branch: row.branch,
    deployOnMerge: row.deploy_on_merge === true || row.deploy_on_merge === 1,
    updatedAt: iso(row.updated_at),
    updatedBy: row.updated_by,
  };
  if (row.method === 'archon-host') return { ...base, method: 'archon-host' };
  if (row.workflow_name === null || row.workflow_name === '') {
    // A workflow deploy that names no workflow has nothing to run.
    getLog().warn({ codebaseId: row.codebase_id }, 'deploy.workflow_unnamed');
    return null;
  }
  return { ...base, method: 'workflow', workflowName: row.workflow_name };
}

const SELECT = `SELECT codebase_id, method, branch, deploy_on_merge, updated_at, updated_by, workflow_name
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
  method: 'archon-host'
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
 * The workflow deploys whose merges ship on their own along `branch`. The caller
 * matches each to the repository the merge happened in.
 */
export async function listMergeDeploysOnBranch(branch: string): Promise<WorkflowProjectDeploy[]> {
  const res = await pool.query<ProjectDeployRow>(
    `${SELECT} WHERE method = 'workflow' AND branch = $1 AND deploy_on_merge = $2`,
    [branch, true]
  );
  return res.rows
    .map(toProjectDeploy)
    .filter((d): d is WorkflowProjectDeploy => d?.method === 'workflow');
}

/**
 * Give a project a workflow deploy. Starts with `deploy_on_merge` off: a project
 * gains the ability to deploy before anyone has decided merges should ship on
 * their own. Null when the project already has a row of any method — setting up
 * never replaces a deploy, including one this binary cannot read.
 */
export async function setUpWorkflowDeploy(
  codebaseId: string,
  branch: string,
  workflowName: string,
  actor: string
): Promise<ProjectDeploy | null> {
  const res = await pool.query<{ codebase_id: string }>(
    `INSERT INTO remote_agent_project_deploy
       (codebase_id, method, branch, workflow_name, deploy_on_merge, updated_at, updated_by)
     VALUES ($1, 'workflow', $2, $3, $4, ${getDialect().now()}, $5)
     ON CONFLICT (codebase_id) DO NOTHING
     RETURNING codebase_id`,
    [codebaseId, branch, workflowName, false, actor]
  );
  if (res.rows.length === 0) return null;
  return getProjectDeploy(codebaseId);
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

// ─── Deploy runs ─────────────────────────────────────────────────────────────

/** Record that `runId` is this project's deploy of `sha`. */
export async function recordDeployRun(
  codebaseId: string,
  runId: string,
  sha: string
): Promise<void> {
  await pool.query(
    `INSERT INTO remote_agent_deploy_runs (run_id, codebase_id, sha, created_at)
     VALUES ($1, $2, $3, ${getDialect().now()})`,
    [runId, codebaseId, sha]
  );
}

export interface DeployRun {
  runId: string;
  sha: string;
  /** When the deploy was started. */
  at: string;
  /** The run's own status: the deploy's verdict, never a copy of it. */
  status: WorkflowRunStatus;
  finishedAt: string | null;
}

interface DeployRunRow {
  run_id: string;
  sha: string;
  created_at: string | Date;
  status: string;
  completed_at: string | Date | null;
}

/** This project's deploy runs, newest first. Another project's runs never appear. */
export async function listDeployRuns(codebaseId: string, limit = 50): Promise<DeployRun[]> {
  const res = await pool.query<DeployRunRow>(
    `SELECT d.run_id, d.sha, d.created_at, r.status, r.completed_at
       FROM remote_agent_deploy_runs d
       JOIN remote_agent_workflow_runs r ON r.id = d.run_id
      WHERE d.codebase_id = $1
      ORDER BY d.created_at DESC
      LIMIT $2`,
    [codebaseId, limit]
  );
  const runs: DeployRun[] = [];
  for (const row of res.rows) {
    const status = workflowRunStatusSchema.safeParse(row.status);
    if (!status.success) {
      getLog().warn({ runId: row.run_id, status: row.status }, 'deploy.run_status_unknown');
      continue;
    }
    runs.push({
      runId: row.run_id,
      sha: row.sha,
      at: iso(row.created_at),
      status: status.data,
      finishedAt: row.completed_at === null ? null : iso(row.completed_at),
    });
  }
  return runs;
}

// ─── Deploys that did not start ──────────────────────────────────────────────

/**
 * Record that a merge should have started this project's deploy and did not
 * (#236), with the reason the person would have been shown. Its own table,
 * because `remote_agent_deploy_events.kind` is a shipped CHECK list and
 * `deploy_requested` there is the host's proof that a person asked.
 */
export async function recordDeployNotStarted(
  codebaseId: string,
  sha: string,
  trigger: string,
  reason: string
): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `INSERT INTO remote_agent_deploy_not_started (id, codebase_id, sha, trigger_ref, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, ${dialect.now()})`,
    [dialect.generateUuid(), codebaseId, sha, trigger, reason]
  );
}

export interface DeployNotStarted {
  sha: string;
  /** What asked for the deploy, e.g. `owner/repo#123` for a merged PR. */
  trigger: string;
  reason: string;
  at: string;
}

interface DeployNotStartedRow {
  sha: string;
  trigger_ref: string;
  reason: string;
  created_at: string | Date;
}

/** This project's deploys that did not start, newest first. Another project's never appear. */
export async function listDeployNotStarted(
  codebaseId: string,
  limit = 50
): Promise<DeployNotStarted[]> {
  const res = await pool.query<DeployNotStartedRow>(
    `SELECT sha, trigger_ref, reason, created_at
       FROM remote_agent_deploy_not_started
      WHERE codebase_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [codebaseId, limit]
  );
  return res.rows.map(row => ({
    sha: row.sha,
    trigger: row.trigger_ref,
    reason: row.reason,
    at: iso(row.created_at),
  }));
}
