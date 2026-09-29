/**
 * The per-project deploy controls (#211, #226).
 *
 *   GET    /api/projects/:projectId/deploy       the header's deploy bar, or what
 *                                                Set up deploys starts filled with
 *   PUT    /api/projects/:projectId/deploy       Set up deploys          (person only)
 *   PATCH  /api/projects/:projectId/deploy       flip Deploy on Merge    (person only)
 *   POST   /api/projects/:projectId/deploy       Deploy now              (person only)
 *   DELETE /api/projects/:projectId/deploy       Cancel deploy           (person only)
 *   GET    /api/projects/:projectId/deploy/log   the Overview tab's deploy log
 *
 *   GET    /internal/deploy-policy               the host's question, drain-token gated
 *   GET    /internal/remote-deploy/policy        a remote host's question  (its own credential)
 *   POST   /internal/remote-deploy/report        what a remote host did    (its own credential)
 *
 * Each handler acts on the project in its path and on that project's method:
 * `archon-host` drives this install's own deploy (services/deploy-control.ts),
 * `workflow` runs the deploy workflow in the project's repository
 * (services/workflow-deploy.ts), and `remote-host` is a host that deploys
 * itself and asks first (services/remote-deploy.ts). Set up deploys creates
 * only `workflow` rows.
 *
 * PERSON ONLY means a verified Cloudflare Access pass on the request — see
 * services/human-pass.ts for why a header an agent can set is not enough. The
 * check runs before anything else in each handler, so a refused request changes
 * nothing and reads nothing.
 *
 * `app.get` rather than registerOpenApiRoute for all but the log, the same
 * call the issue routes make: the console reads these through its own typed
 * wrapper, and the shape includes the deploy status the health schema already
 * pins. The log is an OpenAPI route so its entry kinds reach the console's
 * generated types from the one list the server builds them from (#235).
 */

import type { Context } from 'hono';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import * as codebaseDb from '@archon/core/db/codebases';
import * as projectDeployDb from '@archon/core/db/project-deploy';
import type { ProjectDeploy } from '@archon/core/db/project-deploy';
import type { Codebase } from '@archon/core';
import { createLogger } from '@archon/paths';
import { isAuthorizedDrainRequest } from './internal-drain';
import { errorSchema } from './schemas/common.schemas';
import { deployLogResponseSchema, projectIdParamsSchema } from './schemas/deploy.schemas';
import { checkHumanPass, HUMAN_PASS_HEADER, humanPassRefusal } from '../services/human-pass';
import {
  cancelDeploy,
  decideFor,
  decidePolicy,
  deployNow,
  getDeployLog,
  getProjectDeployView,
} from '../services/deploy-control';
import {
  type DeployHost,
  cancelWorkflowDeploy,
  deployWorkflowNow,
  getWorkflowDeployLog,
  getWorkflowDeployView,
  listDeployableWorkflows,
  readDeploySetup,
} from '../services/workflow-deploy';
import {
  deployRemoteNow,
  getRemoteDeployLog,
  getRemoteDeployView,
} from '../services/remote-deploy';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('project-deploy');
  return cachedLog;
}

const deployLogRoute = createRoute({
  method: 'get',
  path: '/api/projects/{projectId}/deploy/log',
  tags: ['Deploy'],
  summary: "A project's deploy log: console actions, deploy starts and verdicts, newest first",
  request: { params: projectIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: deployLogResponseSchema } },
      description: 'OK',
    },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'No project' },
  },
});

/** What is running, for the Deploy now confirm: chats mid-turn and workflow runs. */
export type RunningCounter = () => Promise<{ chats: number; workflows: number }>;

/** The person behind a request, or the refusal to send back. */
async function requirePerson(c: Context): Promise<{ email: string } | Response> {
  const pass = await checkHumanPass(c.req.header(HUMAN_PASS_HEADER));
  if (pass.ok) return { email: pass.email };
  getLog().warn({ path: c.req.path, reason: pass.reason }, 'deploy.person_only_refused');
  return c.json({ error: humanPassRefusal(pass.reason), reason: pass.reason }, 403);
}

async function loadProject(
  projectId: string
): Promise<{ codebase: Codebase; setting: ProjectDeploy | null } | null> {
  const codebase = await codebaseDb.getCodebase(projectId);
  if (codebase === null) return null;
  const setting = await projectDeployDb.getProjectDeploy(projectId);
  return { codebase, setting };
}

export function registerProjectDeployRoutes(
  app: OpenAPIHono,
  countRunning: RunningCounter,
  deployHost: DeployHost | null
): void {
  app.get('/api/projects/:projectId/deploy', async c => {
    const found = await loadProject(c.req.param('projectId'));
    if (found === null) return c.json({ error: 'Project not found' }, 404);
    // `canAct` lets the console say why the buttons will be refused before
    // anyone presses one. It is advice to the UI; every action checks again.
    const pass = checkHumanPass(c.req.header(HUMAN_PASS_HEADER));
    const { codebase, setting } = found;
    if (setting === null) {
      // No row: the bar says "not set up", and this is what the picker offers.
      const [setup, { ok }] = await Promise.all([readDeploySetup(codebase), pass]);
      return c.json({ deploy: null, setup, canAct: ok });
    }
    if (setting.method === 'workflow') {
      const [view, { ok }] = await Promise.all([
        getWorkflowDeployView(codebase, setting, deployHost),
        pass,
      ]);
      return c.json({ deploy: { ...view, canAct: ok } });
    }
    if (setting.method === 'remote-host') {
      const [view, { ok }] = await Promise.all([getRemoteDeployView(codebase, setting), pass]);
      return c.json({ deploy: { ...view, canAct: ok } });
    }
    const [view, running, { ok }] = await Promise.all([
      getProjectDeployView(codebase, setting),
      countRunning(),
      pass,
    ]);
    return c.json({ deploy: { ...view, running, canAct: ok } });
  });

  app.put('/api/projects/:projectId/deploy', async c => {
    const person = await requirePerson(c);
    if (person instanceof Response) return person;
    const body = (await c.req.json().catch(() => null)) as {
      branch?: unknown;
      workflowName?: unknown;
    } | null;
    const branch = typeof body?.branch === 'string' ? body.branch.trim() : '';
    const workflowName = typeof body?.workflowName === 'string' ? body.workflowName.trim() : '';
    if (branch === '' || workflowName === '') {
      return c.json({ error: 'branch and workflowName are required' }, 400);
    }
    const codebase = await codebaseDb.getCodebase(c.req.param('projectId'));
    if (codebase === null) return c.json({ error: 'Project not found' }, 404);
    if (!(await listDeployableWorkflows(codebase)).includes(workflowName)) {
      return c.json({ error: `This project has no workflow named "${workflowName}".` }, 400);
    }
    const created = await projectDeployDb.setUpWorkflowDeploy(
      codebase.id,
      branch,
      workflowName,
      person.email
    );
    if (created === null) return c.json({ error: 'This project already has a deploy' }, 409);
    getLog().info(
      { projectId: codebase.id, branch, workflowName, by: person.email },
      'deploy.set_up'
    );
    return c.json({ deploy: created }, 201);
  });

  app.patch('/api/projects/:projectId/deploy', async c => {
    const person = await requirePerson(c);
    if (person instanceof Response) return person;
    const body = (await c.req.json().catch(() => null)) as { deployOnMerge?: unknown } | null;
    if (typeof body?.deployOnMerge !== 'boolean') {
      return c.json({ error: 'deployOnMerge must be true or false' }, 400);
    }
    const projectId = c.req.param('projectId');
    const changed = await projectDeployDb.setDeployOnMerge(
      projectId,
      body.deployOnMerge,
      person.email
    );
    if (changed === null) return c.json({ error: 'This project has no deploy' }, 404);
    getLog().info(
      { projectId, from: changed.before, to: changed.after.deployOnMerge, by: person.email },
      'deploy.toggle_flipped'
    );
    return c.json({ deployOnMerge: changed.after.deployOnMerge });
  });

  app.post('/api/projects/:projectId/deploy', async c => {
    const person = await requirePerson(c);
    if (person instanceof Response) return person;
    const body = (await c.req.json().catch(() => null)) as { sha?: unknown } | null;
    if (typeof body?.sha !== 'string') return c.json({ error: 'sha is required' }, 400);
    const found = await loadProject(c.req.param('projectId'));
    if (found === null) return c.json({ error: 'Project not found' }, 404);
    const { codebase, setting } = found;
    if (setting === null) return c.json({ error: 'This project has no deploy' }, 404);
    const result =
      setting.method === 'workflow'
        ? await deployWorkflowNow(codebase, setting, body.sha, person.email, deployHost)
        : setting.method === 'remote-host'
          ? await deployRemoteNow(codebase, setting, body.sha, person.email)
          : await deployNow(codebase, setting, body.sha, person.email);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    getLog().info({ projectId: codebase.id, sha: body.sha, by: person.email }, 'deploy.now');
    return c.json({ requested: body.sha }, 202);
  });

  app.delete('/api/projects/:projectId/deploy', async c => {
    const person = await requirePerson(c);
    if (person instanceof Response) return person;
    const found = await loadProject(c.req.param('projectId'));
    if (found === null) return c.json({ error: 'Project not found' }, 404);
    const { codebase, setting } = found;
    if (setting === null) return c.json({ error: 'This project has no deploy' }, 404);
    if (setting.method === 'workflow') {
      const result = await cancelWorkflowDeploy(codebase.id, person.email);
      if (!result.ok) return c.json({ error: result.error }, result.status);
      getLog().info(
        { projectId: codebase.id, runId: result.runId, by: person.email },
        'deploy.cancel'
      );
      return c.json({ cancelled: 'run-cancelled' });
    }
    if (setting.method === 'remote-host') {
      // The host's deploy is seconds long and runs where Archon cannot stop it.
      return c.json(
        { error: 'This project deploys on its own host; there is nothing to cancel.' },
        409
      );
    }
    const result = await cancelDeploy(codebase.id, person.email);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    getLog().info({ projectId: codebase.id, how: result.how, by: person.email }, 'deploy.cancel');
    return c.json({ cancelled: result.how });
  });

  app.openapi(deployLogRoute, async c => {
    const found = await loadProject(c.req.valid('param').projectId);
    if (found === null) return c.json({ error: 'Project not found' }, 404);
    const { codebase, setting } = found;
    if (setting === null) return c.json({ entries: [] }, 200);
    // The host's deploy-history is this install's, so only the archon-host
    // project reads it; a workflow project's log is its own runs.
    const entries =
      setting.method === 'workflow'
        ? await getWorkflowDeployLog(codebase.id)
        : setting.method === 'remote-host'
          ? await getRemoteDeployLog(codebase.id)
          : await getDeployLog(codebase.id);
    return c.json({ entries }, 200);
  });
}

/**
 * The host's question, answered as one machine token. Registered only when a
 * drain token is configured, beside the drain routes it shares a credential with.
 */
export function registerDeployPolicyRoute(app: OpenAPIHono, token: string): void {
  app.get('/internal/deploy-policy', async c => {
    if (!isAuthorizedDrainRequest(c.req.header('Authorization'), token)) {
      return c.text('unauthorized', 401);
    }
    if (c.req.query('method') !== 'archon-host') return c.text('hold:unknown-method');
    try {
      const answer = await decidePolicy({
        source: c.req.query('source'),
        sha: c.req.query('sha'),
        request: c.req.query('request'),
      });
      getLog().info(
        { source: c.req.query('source'), sha: c.req.query('sha'), answer },
        'deploy.policy_answered'
      );
      return c.text(answer);
    } catch (err) {
      // The host holds on anything it does not recognise, so failing here is
      // safe; the log says why.
      getLog().error({ err }, 'deploy.policy_failed');
      return c.text('hold:policy-error', 500);
    }
  });
}

const REPORT_SHA = /^[0-9a-f]{40}$/u;

/**
 * A remote host's two calls (#220). Always registered: the credential lives in
 * the project's deploy row, so an install with no remote-host row answers every
 * call 401 and gains no working surface.
 *
 * The policy answer is the same machine token `/internal/deploy-policy` gives —
 * `run` or `hold:<reason>` — decided by the same function, so the two hosts
 * cannot drift apart on what Deploy on Merge means.
 */
export function registerRemoteDeployRoutes(app: OpenAPIHono): void {
  async function remoteFor(c: Context): Promise<ProjectDeploy | null> {
    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ')) return null;
    return projectDeployDb.findRemoteDeployByToken(header.slice('Bearer '.length).trim());
  }

  app.get('/internal/remote-deploy/policy', async c => {
    const setting = await remoteFor(c).catch((err: unknown) => {
      getLog().error({ err }, 'deploy.remote_policy_lookup_failed');
      return undefined;
    });
    // The host holds on anything but `run`, so an error here is safe.
    if (setting === undefined) return c.text('hold:policy-error', 500);
    if (setting === null) return c.text('unauthorized', 401);
    const query = {
      source: c.req.query('source'),
      sha: c.req.query('sha'),
      request: c.req.query('request'),
    };
    try {
      const answer = await decideFor(setting, query);
      getLog().info(
        { projectId: setting.codebaseId, source: query.source, sha: query.sha, answer },
        'deploy.remote_policy_answered'
      );
      return c.text(answer);
    } catch (err) {
      getLog().error({ err, projectId: setting.codebaseId }, 'deploy.remote_policy_failed');
      return c.text('hold:policy-error', 500);
    }
  });

  app.post('/internal/remote-deploy/report', async c => {
    const setting = await remoteFor(c);
    if (setting === null) return c.text('unauthorized', 401);
    const body = (await c.req.json().catch(() => null)) as {
      verdict?: unknown;
      sha?: unknown;
      live?: unknown;
      reason?: unknown;
    } | null;
    const verdict = body?.verdict;
    const sha = body?.sha;
    const live = body?.live;
    if (
      !projectDeployDb.isDeployReportVerdict(verdict) ||
      typeof sha !== 'string' ||
      !REPORT_SHA.test(sha) ||
      typeof live !== 'string' ||
      !REPORT_SHA.test(live)
    ) {
      return c.json(
        { error: 'verdict must be held, ok or failed; sha and live must be full commit SHAs' },
        400
      );
    }
    const reason = typeof body?.reason === 'string' && body.reason !== '' ? body.reason : null;
    await projectDeployDb.recordDeployReport(setting.codebaseId, {
      verdict,
      sha,
      liveSha: live,
      reason: reason === null ? null : reason.slice(0, 500),
    });
    getLog().info(
      { projectId: setting.codebaseId, verdict, sha, live, reason },
      'deploy.remote_reported'
    );
    return c.body(null, 204);
  });
}
