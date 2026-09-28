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
 *
 * Each handler acts on the project in its path and on that project's method:
 * `archon-host` drives this install's own deploy (services/deploy-control.ts),
 * `workflow` runs the deploy workflow in the project's repository
 * (services/workflow-deploy.ts). Set up deploys creates only `workflow` rows.
 *
 * PERSON ONLY means a verified Cloudflare Access pass on the request — see
 * services/human-pass.ts for why a header an agent can set is not enough. The
 * check runs before anything else in each handler, so a refused request changes
 * nothing and reads nothing.
 *
 * `app.get` rather than registerOpenApiRoute, the same call the issue routes
 * make: the console reads these through its own typed wrapper, and the shape
 * includes the deploy status the health schema already pins.
 */

import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import * as codebaseDb from '@archon/core/db/codebases';
import * as projectDeployDb from '@archon/core/db/project-deploy';
import type { ProjectDeploy } from '@archon/core/db/project-deploy';
import type { Codebase } from '@archon/core';
import { createLogger } from '@archon/paths';
import { isAuthorizedDrainRequest } from './internal-drain';
import { checkHumanPass, HUMAN_PASS_HEADER, humanPassRefusal } from '../services/human-pass';
import {
  cancelDeploy,
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

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('project-deploy');
  return cachedLog;
}

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
    const result = await cancelDeploy(codebase.id, person.email);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    getLog().info({ projectId: codebase.id, how: result.how, by: person.email }, 'deploy.cancel');
    return c.json({ cancelled: result.how });
  });

  app.get('/api/projects/:projectId/deploy/log', async c => {
    const found = await loadProject(c.req.param('projectId'));
    if (found === null) return c.json({ error: 'Project not found' }, 404);
    const { codebase, setting } = found;
    if (setting === null) return c.json({ entries: [] });
    // The host's deploy-history is this install's, so only the archon-host
    // project reads it; a workflow project's log is its own runs.
    const entries =
      setting.method === 'workflow'
        ? await getWorkflowDeployLog(codebase.id)
        : await getDeployLog(codebase.id);
    return c.json({ entries });
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
