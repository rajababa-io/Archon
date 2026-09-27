/**
 * The per-project deploy controls (#211).
 *
 *   GET    /api/projects/:projectId/deploy       the header's deploy row
 *   PATCH  /api/projects/:projectId/deploy       flip Deploy on Merge   (person only)
 *   POST   /api/projects/:projectId/deploy       Deploy now             (person only)
 *   DELETE /api/projects/:projectId/deploy       Cancel deploy          (person only)
 *   GET    /api/projects/:projectId/deploy/log   the Overview tab's deploy log
 *
 *   GET    /internal/deploy-policy               the host's question, drain-token gated
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

export function registerProjectDeployRoutes(app: OpenAPIHono, countRunning: RunningCounter): void {
  app.get('/api/projects/:projectId/deploy', async c => {
    const found = await loadProject(c.req.param('projectId'));
    if (found === null) return c.json({ error: 'Project not found' }, 404);
    // No row is the ordinary answer for most projects: the console draws no
    // deploy row for them.
    if (found.setting === null) return c.json({ deploy: null });
    const [view, running, pass] = await Promise.all([
      getProjectDeployView(found.codebase, found.setting),
      countRunning(),
      checkHumanPass(c.req.header(HUMAN_PASS_HEADER)),
    ]);
    // `canAct` lets the console say why the buttons will be refused before
    // anyone presses one. It is advice to the UI; every action checks again.
    return c.json({ deploy: { ...view, running, canAct: pass.ok } });
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
    if (found.setting === null) return c.json({ error: 'This project has no deploy' }, 404);
    const result = await deployNow(found.codebase, found.setting, body.sha, person.email);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    getLog().info({ projectId: found.codebase.id, sha: body.sha, by: person.email }, 'deploy.now');
    return c.json({ requested: body.sha }, 202);
  });

  app.delete('/api/projects/:projectId/deploy', async c => {
    const person = await requirePerson(c);
    if (person instanceof Response) return person;
    const found = await loadProject(c.req.param('projectId'));
    if (found === null) return c.json({ error: 'Project not found' }, 404);
    if (found.setting === null) return c.json({ error: 'This project has no deploy' }, 404);
    const result = await cancelDeploy(found.codebase.id, person.email);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    getLog().info(
      { projectId: found.codebase.id, how: result.how, by: person.email },
      'deploy.cancel'
    );
    return c.json({ cancelled: result.how });
  });

  app.get('/api/projects/:projectId/deploy/log', async c => {
    const found = await loadProject(c.req.param('projectId'));
    if (found === null) return c.json({ error: 'Project not found' }, 404);
    if (found.setting === null) return c.json({ entries: [] });
    return c.json({ entries: await getDeployLog(found.codebase.id) });
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
