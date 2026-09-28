/**
 * Zod schemas for the Web Push endpoints (`routes/push.ts`).
 */
import { z } from '@hono/zod-openapi';
import { NOTIFY_MODES } from '@archon/core/db/push';
import { isPushServiceEndpoint, readSubscriptionKeys } from '../../services/web-push';

/**
 * GET /api/push/vapid-key. Disabled names each unset variable, or the problem
 * with a set one, so Settings can say exactly what to fix.
 */
export const pushVapidKeyResponseSchema = z
  .discriminatedUnion('enabled', [
    z.object({ enabled: z.literal(true), publicKey: z.string() }),
    z.object({
      enabled: z.literal(false),
      missing: z.array(z.string()),
      problem: z.string().nullable(),
    }),
  ])
  .openapi('PushVapidKeyResponse');

/** POST /api/push/subscribe — the browser's `PushSubscription.toJSON()`. */
export const pushSubscribeBodySchema = z
  .object({
    endpoint: z.string().url().refine(isPushServiceEndpoint, {
      message: 'endpoint must be an https URL on a browser push service',
    }),
    keys: z
      .object({ p256dh: z.string(), auth: z.string() })
      .refine(keys => readSubscriptionKeys(keys) !== null, {
        message: 'p256dh must be an uncompressed P-256 key and auth a secret, both base64url',
      }),
  })
  .openapi('PushSubscribeBody');

/** DELETE /api/push/subscribe. */
export const pushUnsubscribeBodySchema = z
  .object({ endpoint: z.string().min(1) })
  .openapi('PushUnsubscribeBody');

export const pushTriggersSchema = z
  .object({ awaiting: z.boolean(), runFinished: z.boolean(), runFailed: z.boolean() })
  .openapi('PushTriggers');

/** GET /api/push/prefs, and what PUT answers with. Only exceptions to `default` are listed. */
export const pushPrefsSchema = z
  .object({
    triggers: pushTriggersSchema,
    /** Codebase ids of muted projects. */
    mutedProjects: z.array(z.string()),
    /** Platform conversation id → the chat's own mode. */
    conversations: z.record(z.string(), z.enum(NOTIFY_MODES).exclude(['default'])),
  })
  .openapi('PushPrefs');

/** PUT /api/push/prefs — one change: the global triggers, a project's mute, or a chat's mode. */
export const pushPrefsChangeSchema = z
  .discriminatedUnion('scope', [
    z.object({ scope: z.literal('global'), triggers: pushTriggersSchema.partial() }),
    z.object({
      scope: z.literal('project'),
      id: z.string().min(1),
      mode: z.enum(NOTIFY_MODES).exclude(['following']),
    }),
    z.object({
      scope: z.literal('conversation'),
      id: z.string().min(1),
      mode: z.enum(NOTIFY_MODES),
    }),
  ])
  .openapi('PushPrefsChange');

/** POST /api/push/test — what the push services said, per subscribed browser. */
export const pushTestResponseSchema = z
  .object({ delivered: z.number(), failed: z.number(), removed: z.number() })
  .openapi('PushTestResponse');

/**
 * POST /api/push/presence — one console's heartbeat: the chat it is showing
 * while visible, or null. `clientId` is per page load, so two tabs are two
 * clients.
 */
export const pushPresenceBodySchema = z
  .object({ clientId: z.string().min(1).max(100), conversationId: z.string().min(1).nullable() })
  .openapi('PushPresenceBody');

export const pushOkResponseSchema = z.object({ success: z.boolean() }).openapi('PushOkResponse');
