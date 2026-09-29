/**
 * The console tab each signed-in person last picked (#251).
 *
 *   GET /api/console/views   every choice the caller has made, by scope id
 *   PUT /api/console/views   record one choice
 *
 * The person is the email on a verified Cloudflare Access pass, not
 * `requireWebUser`. Giving that resolver an identity would also switch on
 * per-user chat listing, AI prefs and GitHub tokens — and narrow the chat list
 * to chats the new identity owns, which on an install that never had one is
 * none of them. Remembering a tab should not change what else the console
 * shows.
 *
 * Without a pass both answer 401 and the console keeps its browser-local copy,
 * so an install without Access behaves as it did before this existed.
 */
import { createRoute, type OpenAPIHono, type z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import * as viewPrefsDb from '@archon/core/db/console-view-prefs';
import { createLogger } from '@archon/paths';
import { errorSchema } from './schemas/common.schemas';
import {
  consoleViewChangeSchema,
  consoleViewSchema,
  consoleViewsSchema,
} from './schemas/console-views.schemas';
import { checkHumanPass, HUMAN_PASS_HEADER, humanPassRefusal } from '../services/human-pass';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('console-views');
  return cachedLog;
}

const json = <T>(schema: T, description: string) =>
  ({ content: { 'application/json': { schema } }, description }) as const;

const getViewsRoute = createRoute({
  method: 'get',
  path: '/api/console/views',
  tags: ['Console'],
  summary: 'The console tabs the signed-in person last picked',
  responses: {
    200: json(consoleViewsSchema, 'OK'),
    401: json(errorSchema, 'No verified Cloudflare Access pass on the request'),
  },
});

const putViewRoute = createRoute({
  method: 'put',
  path: '/api/console/views',
  tags: ['Console'],
  summary: 'Record the tab the signed-in person picked for one scope',
  request: {
    body: { content: { 'application/json': { schema: consoleViewChangeSchema } }, required: true },
  },
  responses: {
    200: json(consoleViewsSchema, 'The choices after the change'),
    401: json(errorSchema, 'No verified Cloudflare Access pass on the request'),
  },
});

async function person(c: Context): Promise<string | { error: string }> {
  const pass = await checkHumanPass(c.req.header(HUMAN_PASS_HEADER));
  return pass.ok ? pass.email : { error: humanPassRefusal(pass.reason) };
}

/**
 * Stored values are read back through the schema: a row written by a build
 * that knew a tab this one does not is left out rather than sent as a view the
 * console cannot route to.
 */
async function readViews(
  email: string
): Promise<Record<string, z.infer<typeof consoleViewSchema>>> {
  const views: Record<string, z.infer<typeof consoleViewSchema>> = {};
  for (const [scopeId, raw] of Object.entries(await viewPrefsDb.readConsoleViews(email))) {
    const parsed = consoleViewSchema.safeParse(raw);
    if (parsed.success) views[scopeId] = parsed.data;
    else getLog().warn({ scopeId, view: raw }, 'console_views.unknown_view_skipped');
  }
  return views;
}

export function registerConsoleViewRoutes(app: OpenAPIHono): void {
  app.openapi(getViewsRoute, async c => {
    const who = await person(c);
    if (typeof who !== 'string') return c.json(who, 401);
    return c.json({ views: await readViews(who) }, 200);
  });

  app.openapi(putViewRoute, async c => {
    const who = await person(c);
    if (typeof who !== 'string') return c.json(who, 401);
    const { scopeId, view } = c.req.valid('json');
    await viewPrefsDb.setConsoleView(who, scopeId, view);
    return c.json({ views: await readViews(who) }, 200);
  });
}
