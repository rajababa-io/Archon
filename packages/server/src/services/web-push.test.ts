import { describe, expect, test } from 'bun:test';
import {
  decodeBase64Url,
  encodeBase64Url,
  encryptPayload,
  isPushServiceEndpoint,
  generateEcdhKeyPair,
  importEcdhKeyPair,
  readVapidConfig,
  sendWebPush,
  vapidAuthorization,
  type VapidKeys,
} from './web-push';

const bytes = (s: string): Uint8Array => {
  const out = decodeBase64Url(s);
  if (out === null) throw new Error(`not base64url: ${s}`);
  return out;
};

/** A fresh VAPID key pair, as the environment would carry it. */
async function vapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey: encodeBase64Url(raw),
    privateKey: jwk.d ?? '',
    subject: 'mailto:ops@example.com',
  };
}

describe('encryptPayload', () => {
  test("matches RFC 8291's worked example byte for byte", async () => {
    // RFC 8291 §5 / Appendix A: fixed application-server key pair and salt.
    const local = await importEcdhKeyPair(
      bytes(
        'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
      ),
      bytes('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw')
    );
    const out = await encryptPayload(
      new TextEncoder().encode('When I grow up, I want to be a watermelon'),
      {
        p256dh:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
      { salt: bytes('DGv6ra1nlYgDCS1FRnbzlw'), local }
    );
    expect(encodeBase64Url(out)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
    );
  });

  test('draws a fresh salt and key for every push', async () => {
    const browser = await generateEcdhKeyPair();
    const sub = { p256dh: encodeBase64Url(browser.publicKey), auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
    const payload = new TextEncoder().encode('hi');
    const a = await encryptPayload(payload, sub);
    const b = await encryptPayload(payload, sub);
    expect(encodeBase64Url(a.slice(0, 16))).not.toBe(encodeBase64Url(b.slice(0, 16)));
    expect(encodeBase64Url(a.slice(21, 86))).not.toBe(encodeBase64Url(b.slice(21, 86)));
  });

  test('refuses malformed subscription keys instead of sending garbage', async () => {
    const payload = new TextEncoder().encode('hi');
    await expect(encryptPayload(payload, { p256dh: 'short', auth: 'x' })).rejects.toThrow(
      'Push subscription keys are malformed'
    );
  });
});

describe('vapidAuthorization', () => {
  test('signs a token for the push service origin that the public key verifies', async () => {
    const keys = await vapidKeys();
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 1_000);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    if (match === null) throw new Error(`unexpected header: ${header}`);
    const [, head, claims, signature, k] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(bytes(claims)))).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_000 + 12 * 60 * 60,
      sub: 'mailto:ops@example.com',
    });
    const verifier = await crypto.subtle.importKey(
      'raw',
      bytes(keys.publicKey).slice().buffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifier,
      bytes(signature).slice().buffer,
      new TextEncoder().encode(`${head}.${claims}`)
    );
    expect(valid).toBe(true);
  });
});

describe('readVapidConfig', () => {
  test('names every unset variable', () => {
    expect(readVapidConfig({ ARCHON_VAPID_SUBJECT: 'mailto:a@b.c' })).toEqual({
      enabled: false,
      missing: ['ARCHON_VAPID_PUBLIC', 'ARCHON_VAPID_PRIVATE'],
      problem: null,
    });
  });

  test('a malformed key is a problem, stated, not a silent disable', async () => {
    const keys = await vapidKeys();
    const config = readVapidConfig({
      ARCHON_VAPID_PUBLIC: keys.publicKey.slice(0, 20),
      ARCHON_VAPID_PRIVATE: keys.privateKey,
      ARCHON_VAPID_SUBJECT: keys.subject,
    });
    expect(config).toMatchObject({ enabled: false, missing: [] });
    expect(config.enabled ? null : config.problem).toContain('ARCHON_VAPID_PUBLIC');
  });

  test('a subject that is not mailto: or https: is refused', async () => {
    const keys = await vapidKeys();
    const config = readVapidConfig({
      ARCHON_VAPID_PUBLIC: keys.publicKey,
      ARCHON_VAPID_PRIVATE: keys.privateKey,
      ARCHON_VAPID_SUBJECT: 'ops@example.com',
    });
    expect(config.enabled ? null : config.problem).toContain('ARCHON_VAPID_SUBJECT');
  });

  test('three well-formed variables enable push', async () => {
    const keys = await vapidKeys();
    expect(
      readVapidConfig({
        ARCHON_VAPID_PUBLIC: ` ${keys.publicKey} `,
        ARCHON_VAPID_PRIVATE: keys.privateKey,
        ARCHON_VAPID_SUBJECT: keys.subject,
      })
    ).toEqual({ enabled: true, keys });
  });
});

describe('sendWebPush', () => {
  async function subscription(): Promise<{ endpoint: string; p256dh: string; auth: string }> {
    const browser = await generateEcdhKeyPair();
    return {
      endpoint: 'https://fcm.googleapis.com/fcm/send/1',
      p256dh: encodeBase64Url(browser.publicKey),
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    };
  }
  const answering = (status: number): typeof fetch =>
    (async () => new Response('no', { status })) as unknown as typeof fetch;

  test('posts an encrypted body with the aes128gcm headers', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const result = await sendWebPush(
      await subscription(),
      '{"title":"t"}',
      await vapidKeys(),
      fetchImpl
    );
    expect(result).toEqual({ outcome: 'delivered' });
    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.Authorization).toStartWith('vapid t=');
    expect(Number(headers.TTL)).toBeGreaterThan(0);
  });

  test('404 and 410 mean the subscription is gone', async () => {
    const keys = await vapidKeys();
    for (const status of [404, 410]) {
      expect(await sendWebPush(await subscription(), 'x', keys, answering(status))).toEqual({
        outcome: 'gone',
        status,
      });
    }
  });

  test('any other refusal is a failure that keeps the subscription', async () => {
    const result = await sendWebPush(await subscription(), 'x', await vapidKeys(), answering(429));
    expect(result).toEqual({ outcome: 'failed', status: 429, detail: 'no' });
  });
});

describe('isPushServiceEndpoint', () => {
  test('accepts the browser push services', () => {
    for (const endpoint of [
      'https://web.push.apple.com/QGq7abc',
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-by3p.notify.windows.com/w/?token=abc',
      'https://WEB.PUSH.APPLE.COM:443/x',
    ]) {
      expect(isPushServiceEndpoint(endpoint)).toBe(true);
    }
  });

  test('refuses anything else the server could be pointed at', () => {
    for (const endpoint of [
      'http://web.push.apple.com/x',
      'https://127.0.0.1/x',
      'https://localhost:3000/api/push/test',
      'https://169.254.169.254/latest/meta-data',
      'https://archon-postgres-1:5432/',
      'https://web.push.apple.com.evil.example/x',
      'https://evilnotify.windows.com/x',
      'https://user:pass@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(isPushServiceEndpoint(endpoint)).toBe(false);
    }
  });

  test('a stored subscription on another host is never fetched', async () => {
    let fetched = false;
    const spy = (async () => {
      fetched = true;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const result = await sendWebPush(
      { endpoint: 'https://127.0.0.1/internal', p256dh: 'unused', auth: 'unused' },
      'x',
      await vapidKeys(),
      spy
    );
    expect(result).toEqual({
      outcome: 'failed',
      status: null,
      detail: 'endpoint is not a known push service',
    });
    expect(fetched).toBe(false);
  });
});
