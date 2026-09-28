/**
 * The push routes: push off says which variables to set, a subscription is
 * stored with the browser it came from, preferences change one scope at a
 * time and reject what they cannot mean, and presence reaches the registry.
 */
import { beforeEach, describe, expect, expectTypeOf, mock, test } from 'bun:test';
import { OpenAPIHono, type z } from '@hono/zod-openapi';
import type { NotifyTriggers, setNotifyMode } from '@archon/core/db/push';
import type { pushPrefsChangeSchema } from './schemas/push.schemas';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const PREFS = {
  triggers: { awaiting: true, runFinished: true, runFailed: true },
  mutedProjects: [],
  conversations: {},
};
const mockSave = mock(async (_input: unknown) => undefined);
const mockDelete = mock(async (_endpoint: string) => true);
const mockSetTriggers = mock(async (_t: unknown) => undefined);
const mockSetMode = mock(async (_t: unknown) => undefined);
mock.module('@archon/core/db/push', () => ({
  NOTIFY_MODES: ['default', 'muted', 'following'],
  savePushSubscription: mockSave,
  deletePushSubscription: mockDelete,
  readNotifyPrefs: async () => PREFS,
  setNotifyTriggers: mockSetTriggers,
  setNotifyMode: mockSetMode,
}));

const { registerPushRoutes } = await import('./push');
const { ChatPresence } = await import('../services/push-presence');
const { validationErrorHook } = await import('./openapi-defaults');

const KEYS = { publicKey: 'BPk', privateKey: 'sk', subject: 'mailto:a@b.c' };
const deliver = mock(async () => ({ delivered: 1, failed: 0, removed: 0 }));

function app(enabled: boolean): { app: OpenAPIHono; presence: InstanceType<typeof ChatPresence> } {
  const a = new OpenAPIHono({ defaultHook: validationErrorHook });
  const presence = new ChatPresence();
  registerPushRoutes(a, {
    vapid: enabled
      ? { enabled: true, keys: KEYS }
      : {
          enabled: false,
          missing: ['ARCHON_VAPID_PRIVATE', 'ARCHON_VAPID_SUBJECT'],
          problem: null,
        },
    presence,
    notifier: { deliver } as never,
  });
  return { app: a, presence };
}

const send = (a: OpenAPIHono, method: string, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(
    a.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'user-agent': 'iPhone Safari' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );

const SUBSCRIPTION = {
  endpoint: 'https://web.push.apple.com/abc',
  expirationTime: null,
  keys: {
    p256dh: Buffer.alloc(65, 4).toString('base64url'),
    auth: Buffer.alloc(16, 7).toString('base64url'),
  },
};

beforeEach(() => {
  mockSave.mockClear();
  mockSetTriggers.mockClear();
  mockSetMode.mockClear();
  deliver.mockClear();
});

describe('push off', () => {
  test('the key route names what to set', async () => {
    const res = await send(app(false).app, 'GET', '/api/push/vapid-key');
    expect(await res.json()).toEqual({
      enabled: false,
      missing: ['ARCHON_VAPID_PRIVATE', 'ARCHON_VAPID_SUBJECT'],
      problem: null,
    });
  });

  test('subscribing and testing are refused with the same sentence', async () => {
    const a = app(false).app;
    for (const [method, path, body] of [
      ['POST', '/api/push/subscribe', SUBSCRIPTION],
      ['POST', '/api/push/test', undefined],
    ] as const) {
      const res = await send(a, method, path, body);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'Push is off: set ARCHON_VAPID_PRIVATE, ARCHON_VAPID_SUBJECT on the server',
      });
    }
    expect(mockSave).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('push on', () => {
  test('the key route hands out the public key', async () => {
    const res = await send(app(true).app, 'GET', '/api/push/vapid-key');
    expect(await res.json()).toEqual({ enabled: true, publicKey: 'BPk' });
  });

  test('a subscription is stored with the browser it came from', async () => {
    const res = await send(app(true).app, 'POST', '/api/push/subscribe', SUBSCRIPTION);
    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith({
      endpoint: SUBSCRIPTION.endpoint,
      p256dh: SUBSCRIPTION.keys.p256dh,
      auth: SUBSCRIPTION.keys.auth,
      userAgent: 'iPhone Safari',
    });
  });

  test('a subscription without keys is refused', async () => {
    const res = await send(app(true).app, 'POST', '/api/push/subscribe', {
      endpoint: SUBSCRIPTION.endpoint,
    });
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  test('a subscription whose keys cannot be encrypted to is refused, not stored', async () => {
    for (const keys of [
      { p256dh: 'BKey', auth: SUBSCRIPTION.keys.auth },
      { p256dh: SUBSCRIPTION.keys.p256dh, auth: '' },
      { p256dh: SUBSCRIPTION.keys.p256dh, auth: 'not base64url!' },
    ]) {
      const res = await send(app(true).app, 'POST', '/api/push/subscribe', {
        ...SUBSCRIPTION,
        keys,
      });
      expect(res.status).toBe(400);
    }
    expect(mockSave).not.toHaveBeenCalled();
  });

  test('a test push reports what the push services said', async () => {
    const res = await send(app(true).app, 'POST', '/api/push/test');
    expect(await res.json()).toEqual({ delivered: 1, failed: 0, removed: 0 });
  });
});

describe('prefs', () => {
  test('the global triggers change by name', async () => {
    const res = await send(app(true).app, 'PUT', '/api/push/prefs', {
      scope: 'global',
      triggers: { runFinished: false },
    });
    expect(res.status).toBe(200);
    expect(mockSetTriggers).toHaveBeenCalledWith({ runFinished: false });
  });

  test('a chat can be followed; a project can only be muted', async () => {
    const a = app(true).app;
    await send(a, 'PUT', '/api/push/prefs', {
      scope: 'conversation',
      id: 'web-1',
      mode: 'following',
    });
    expect(mockSetMode).toHaveBeenCalledWith({
      scope: 'conversation',
      id: 'web-1',
      mode: 'following',
    });
    const res = await send(a, 'PUT', '/api/push/prefs', {
      scope: 'project',
      id: 'p1',
      mode: 'following',
    });
    expect(res.status).toBe(400);
    expect(mockSetMode).toHaveBeenCalledTimes(1);
  });
});

describe('presence', () => {
  test('a heartbeat marks the chat on screen, and null takes it off', async () => {
    const { app: a, presence } = app(true);
    await send(a, 'POST', '/api/push/presence', { clientId: 'tab-1', conversationId: 'web-1' });
    expect(presence.isVisible('web-1')).toBe(true);
    await send(a, 'POST', '/api/push/presence', { clientId: 'tab-1', conversationId: null });
    expect(presence.isVisible('web-1')).toBe(false);
  });
});

test('a preference change is exactly the shape core stores', () => {
  expectTypeOf<z.infer<typeof pushPrefsChangeSchema>>().toEqualTypeOf<
    { scope: 'global'; triggers: Partial<NotifyTriggers> } | Parameters<typeof setNotifyMode>[0]
  >();
});
