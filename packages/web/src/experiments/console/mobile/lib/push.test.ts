import { afterEach, describe, expect, test } from 'bun:test';
import {
  applicationServerKey,
  disablePush,
  enablePush,
  isIosDevice,
  pushAvailability,
  thisPushDevice,
} from './push';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const PIXEL =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

describe('isIosDevice', () => {
  test('an iPhone is iOS; an iPad asking for desktop sites is too', () => {
    expect(isIosDevice(IPHONE, 5)).toBe(true);
    expect(isIosDevice(IPAD_AS_MAC, 5)).toBe(true);
  });

  test('a Mac without a touch screen and an Android phone are not', () => {
    expect(isIosDevice(IPAD_AS_MAC, 0)).toBe(false);
    expect(isIosDevice(PIXEL, 5)).toBe(false);
  });
});

describe('pushAvailability', () => {
  const ready = { ios: false, standalone: false, hasPushApi: true, permission: 'default' } as const;

  test('iOS in a Safari tab must be added to the Home Screen first', () => {
    // Safari in a tab has no Push API at all, so "unsupported" would be the
    // wrong advice: the fix is installing, not another browser.
    expect(pushAvailability({ ...ready, ios: true, hasPushApi: false })).toBe('install-first');
    expect(pushAvailability({ ...ready, ios: true, standalone: true })).toBe('ready');
  });

  test('no Push API elsewhere is unsupported', () => {
    expect(pushAvailability({ ...ready, hasPushApi: false, permission: null })).toBe('unsupported');
  });

  test('a refusal can only be undone in the browser settings', () => {
    expect(pushAvailability({ ...ready, permission: 'denied' })).toBe('denied');
    expect(pushAvailability({ ...ready, permission: 'granted' })).toBe('ready');
  });
});

describe('applicationServerKey', () => {
  test('decodes base64url without padding into the raw key bytes', () => {
    const bytes = new Uint8Array(65).map((_, i) => (i * 37 + 4) % 256);
    const base64url = Buffer.from(bytes).toString('base64url');
    expect(base64url).not.toContain('=');
    expect([...applicationServerKey(base64url)]).toEqual([...bytes]);
  });
});

describe('the browser and the server agree on whether push is on', () => {
  const saved = {
    fetch: globalThis.fetch,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    Notification: Object.getOwnPropertyDescriptor(globalThis, 'Notification'),
  };
  afterEach(() => {
    globalThis.fetch = saved.fetch;
    for (const key of ['navigator', 'Notification'] as const) {
      const d = saved[key];
      if (d === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, d);
    }
  });

  const KEY = 'BPk';
  const calls: string[] = [];

  /** A device whose browser holds `held` (or nothing), talking to a server that answers `status`. */
  function device(opts: { held: boolean; status: number; unsubscribes?: boolean }): {
    subscribed: () => boolean;
  } {
    calls.length = 0;
    let subscribed = opts.held;
    const subscription = {
      endpoint: 'https://push.example/1',
      options: { applicationServerKey: applicationServerKey(KEY).buffer },
      toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } }),
      unsubscribe: (): Promise<boolean> => {
        if (opts.unsubscribes === false) return Promise.resolve(false);
        subscribed = false;
        return Promise.resolve(true);
      },
    };
    const registration = {
      pushManager: {
        getSubscription: () => Promise.resolve(subscribed ? subscription : null),
        subscribe: () => ((subscribed = true), Promise.resolve(subscription)),
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serviceWorker: { getRegistration: () => Promise.resolve(registration) } },
    });
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      value: { requestPermission: () => Promise.resolve('granted') },
    });
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return Promise.resolve(
        new Response(opts.status === 200 ? '{"success":true,"id":"sub-1"}' : '{"error":"down"}', {
          status: opts.status,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as typeof fetch;
    return { subscribed: () => subscribed };
  }

  test('a server that refuses the subscription leaves the browser unsubscribed', async () => {
    const d = device({ held: false, status: 503 });
    await expect(enablePush(KEY)).rejects.toThrow();
    expect(d.subscribed()).toBe(false);
  });

  test('a browser that will not unsubscribe is handed back to the server', async () => {
    const d = device({ held: true, status: 200, unsubscribes: false });
    await expect(disablePush()).rejects.toThrow('would not turn push off');
    expect(d.subscribed()).toBe(true);
    expect(calls).toEqual(['DELETE /api/push/subscribe', 'POST /api/push/subscribe']);
  });

  test('reading "on" registers the subscription again, and a refusal is not "on"', async () => {
    device({ held: true, status: 200 });
    expect(await thisPushDevice()).toBe('sub-1');
    expect(calls).toEqual(['POST /api/push/subscribe']);
    device({ held: true, status: 503 });
    await expect(thisPushDevice()).rejects.toThrow();
    device({ held: false, status: 200 });
    expect(await thisPushDevice()).toBeNull();
    expect(calls).toEqual([]);
  });
});
