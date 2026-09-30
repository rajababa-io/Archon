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
const mockSave = mock(async (_input: unknown) => 'sub-1');
const mockDelete = mock(async (_endpoint: string) => true);
const mockDeleteById = mock(async (id: string) => id === 'sub-1');
const mockListDevices = mock(async () => [
  {
    id: 'sub-1',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    createdAt: '2026-09-28 10:00:00',
    lastSuccessAt: null,
  },
  {
    id: 'sub-2',
    userAgent: null,
    createdAt: '2026-09-30T08:00:00.000Z',
    lastSuccessAt: '2026-09-30T09:00:00.000Z',
  },
]);
const mockSetTriggers = mock(async (_t: unknown) => undefined);
const mockSetMode = mock(async (_t: unknown) => undefined);
mock.module('@archon/core/db/push', () => ({
  NOTIFY_MODES: ['default', 'muted', 'following'],
  savePushSubscription: mockSave,
  deletePushSubscription: mockDelete,
  deletePushSubscriptionById: mockDeleteById,
  listPushDevices: mockListDevices,
  readNotifyPrefs: async () => PREFS,
  setNotifyTriggers: mockSetTriggers,
  setNotifyMode: mockSetMode,
}));

const { registerPushRoutes, deviceLabel } = await import('./push');
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
  mockDeleteById.mockClear();
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
    expect(await res.json()).toEqual({ success: true, id: 'sub-1' });
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

  test('a subscription pointing anywhere but a push service is refused, not stored', async () => {
    for (const endpoint of ['https://127.0.0.1/x', 'http://web.push.apple.com/x']) {
      const res = await send(app(true).app, 'POST', '/api/push/subscribe', {
        ...SUBSCRIPTION,
        endpoint,
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

describe('devices', () => {
  test('the list names each browser and its dates, and never its endpoint or keys', async () => {
    const res = await send(app(true).app, 'GET', '/api/push/subscriptions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      devices: [
        {
          id: 'sub-1',
          label: 'iPhone · Home Screen app',
          created_at: '2026-09-28 10:00:00',
          last_success_at: null,
        },
        {
          id: 'sub-2',
          label: 'Unknown device',
          created_at: '2026-09-30T08:00:00.000Z',
          last_success_at: '2026-09-30T09:00:00.000Z',
        },
      ],
    });
  });

  test('removing one forgets exactly that id', async () => {
    const res = await send(app(true).app, 'DELETE', '/api/push/subscriptions/sub-1');
    expect(res.status).toBe(200);
    expect(mockDeleteById).toHaveBeenCalledTimes(1);
    expect(mockDeleteById).toHaveBeenCalledWith('sub-1');
  });

  test('removing an id nobody has is a 404', async () => {
    const res = await send(app(true).app, 'DELETE', '/api/push/subscriptions/gone');
    expect(res.status).toBe(404);
  });

  test('labels come from the user agent', () => {
    const cases: [string | null, string][] = [
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        'iPhone · Safari',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Mac · Chrome',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        'Windows · Edge',
      ],
      [
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
        'Android · Chrome',
      ],
      ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Linux · Firefox'],
      ['curl/8.0', 'Unknown device'],
      [null, 'Unknown device'],
    ];
    for (const [ua, label] of cases) expect(deviceLabel(ua)).toBe(label);
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
