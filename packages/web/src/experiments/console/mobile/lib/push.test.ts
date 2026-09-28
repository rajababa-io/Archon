import { describe, expect, test } from 'bun:test';
import { applicationServerKey, isIosDevice, pushAvailability } from './push';

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
