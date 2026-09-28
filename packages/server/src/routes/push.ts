/**
 * Web Push endpoints for the phone.
 *
 *   GET    /api/push/vapid-key   the key a browser subscribes with, or why push is off
 *   POST   /api/push/subscribe   store this browser's subscription
 *   DELETE /api/push/subscribe   forget it
 *   GET    /api/push/prefs       global triggers, muted projects, per-chat modes
 *   PUT    /api/push/prefs       change one of those
 *   POST   /api/push/test        push a test notification to every subscribed browser
 *   POST   /api/push/presence    a console's heartbeat: the chat it is showing
 *
 * Registered apart from `registerApiRoutes` because these need the notifier
 * and the presence registry the server builds at startup;
 * `scripts/generate-api-types.ts` registers them too, so their shapes reach the
 * console's generated types.
 */
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import * as pushDb from '@archon/core/db/push';
import { errorSchema } from './schemas/common.schemas';
import {
  pushOkResponseSchema,
  pushPrefsChangeSchema,
  pushPrefsSchema,
  pushPresenceBodySchema,
  pushSubscribeBodySchema,
  pushTestResponseSchema,
  pushUnsubscribeBodySchema,
  pushVapidKeyResponseSchema,
} from './schemas/push.schemas';
import { TEST_PUSH, type PushNotifier } from '../services/push-notifier';
import type { ChatPresence } from '../services/push-presence';
import type { VapidConfig } from '../services/web-push';

export interface PushRoutesDeps {
  vapid: VapidConfig;
  presence: ChatPresence;
  notifier: PushNotifier;
}

const json = <T>(schema: T, description: string) =>
  ({ content: { 'application/json': { schema } }, description }) as const;
const jsonBody = <T>(schema: T) =>
  ({ body: { content: { 'application/json': { schema } }, required: true } }) as const;

const vapidKeyRoute = createRoute({
  method: 'get',
  path: '/api/push/vapid-key',
  tags: ['Push'],
  summary: 'The VAPID public key to subscribe with, or why push is off',
  responses: { 200: json(pushVapidKeyResponseSchema, 'OK') },
});

const subscribeRoute = createRoute({
  method: 'post',
  path: '/api/push/subscribe',
  tags: ['Push'],
  summary: "Store this browser's push subscription",
  request: jsonBody(pushSubscribeBodySchema),
  responses: {
    200: json(pushOkResponseSchema, 'Stored'),
    503: json(errorSchema, 'Push is not configured on this server'),
  },
});

const unsubscribeRoute = createRoute({
  method: 'delete',
  path: '/api/push/subscribe',
  tags: ['Push'],
  summary: "Forget this browser's push subscription",
  request: jsonBody(pushUnsubscribeBodySchema),
  responses: { 200: json(pushOkResponseSchema, 'Forgotten, or was never stored') },
});

const getPrefsRoute = createRoute({
  method: 'get',
  path: '/api/push/prefs',
  tags: ['Push'],
  summary: 'What to be notified about',
  responses: { 200: json(pushPrefsSchema, 'OK') },
});

const putPrefsRoute = createRoute({
  method: 'put',
  path: '/api/push/prefs',
  tags: ['Push'],
  summary: 'Change the global triggers, a project mute, or a chat mode',
  request: jsonBody(pushPrefsChangeSchema),
  responses: { 200: json(pushPrefsSchema, 'The preferences after the change') },
});

const testRoute = createRoute({
  method: 'post',
  path: '/api/push/test',
  tags: ['Push'],
  summary: 'Push a test notification to every subscribed browser',
  responses: {
    200: json(pushTestResponseSchema, 'What the push services said'),
    503: json(errorSchema, 'Push is not configured on this server'),
  },
});

const presenceRoute = createRoute({
  method: 'post',
  path: '/api/push/presence',
  tags: ['Push'],
  summary: 'Report the chat this console is showing, so it is not pushed about',
  request: jsonBody(pushPresenceBodySchema),
  responses: { 200: json(pushOkResponseSchema, 'Recorded') },
});

/** Why push is off, as one sentence for a 503. */
function disabledReason(vapid: Extract<VapidConfig, { enabled: false }>): string {
  if (vapid.problem !== null) return `Push is off: ${vapid.problem}`;
  return `Push is off: set ${vapid.missing.join(', ')} on the server`;
}

export function registerPushRoutes(app: OpenAPIHono, deps: PushRoutesDeps): void {
  const { vapid, presence, notifier } = deps;

  app.openapi(vapidKeyRoute, c =>
    c.json(
      vapid.enabled
        ? { enabled: true as const, publicKey: vapid.keys.publicKey }
        : { enabled: false as const, missing: vapid.missing, problem: vapid.problem },
      200
    )
  );

  app.openapi(subscribeRoute, async c => {
    if (!vapid.enabled) return c.json({ error: disabledReason(vapid) }, 503);
    const body = c.req.valid('json');
    await pushDb.savePushSubscription({
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: c.req.header('user-agent') ?? null,
    });
    return c.json({ success: true }, 200);
  });

  app.openapi(unsubscribeRoute, async c => {
    await pushDb.deletePushSubscription(c.req.valid('json').endpoint);
    return c.json({ success: true }, 200);
  });

  app.openapi(getPrefsRoute, async c => c.json(await pushDb.readNotifyPrefs(), 200));

  app.openapi(putPrefsRoute, async c => {
    const change = c.req.valid('json');
    if (change.scope === 'global') await pushDb.setNotifyTriggers(change.triggers);
    else await pushDb.setNotifyMode(change);
    return c.json(await pushDb.readNotifyPrefs(), 200);
  });

  app.openapi(testRoute, async c => {
    if (!vapid.enabled) return c.json({ error: disabledReason(vapid) }, 503);
    return c.json(await notifier.deliver(TEST_PUSH), 200);
  });

  app.openapi(presenceRoute, c => {
    const { clientId, conversationId } = c.req.valid('json');
    presence.report(clientId, conversationId);
    return c.json({ success: true }, 200);
  });
}
