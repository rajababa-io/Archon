/**
 * Web Push delivery: VAPID (RFC 8292) and `aes128gcm` payload encryption
 * (RFC 8291 over RFC 8188), on WebCrypto.
 *
 * Written here rather than taken from the `web-push` package because the whole
 * protocol is a JWT signature, one ECDH, three HKDFs and one AES-GCM call —
 * all of which WebCrypto does natively under Bun — and a dependency for that
 * would bring its own HTTP client and Node-crypto paths along with it.
 * `web-push.test.ts` checks the encryption against RFC 8291's own example.
 *
 * Keys come from the environment only. Nothing here generates or stores one:
 * a key the server minted for itself would change on every container swap and
 * silently orphan every subscription made against the old one.
 */
import type { JsonWebKey } from 'node:crypto';

export const VAPID_ENV = {
  publicKey: 'ARCHON_VAPID_PUBLIC',
  privateKey: 'ARCHON_VAPID_PRIVATE',
  subject: 'ARCHON_VAPID_SUBJECT',
} as const;

export interface VapidKeys {
  /** The uncompressed P-256 public key, base64url — what a browser subscribes with. */
  publicKey: string;
  /** The private scalar `d`, base64url. */
  privateKey: string;
  /** `mailto:` or `https:` — who the push service can contact about this sender. */
  subject: string;
}

export type VapidConfig =
  | { enabled: true; keys: VapidKeys }
  | { enabled: false; missing: string[]; problem: string | null };

/**
 * Read the VAPID keys from the environment. Unset variables are listed by name
 * so Settings can say exactly what to set; a set but malformed key is a
 * problem, not a missing one, and says why.
 */
export function readVapidConfig(env: Record<string, string | undefined>): VapidConfig {
  const publicKey = env[VAPID_ENV.publicKey]?.trim() ?? '';
  const privateKey = env[VAPID_ENV.privateKey]?.trim() ?? '';
  const subject = env[VAPID_ENV.subject]?.trim() ?? '';
  const missing: string[] = [];
  if (publicKey === '') missing.push(VAPID_ENV.publicKey);
  if (privateKey === '') missing.push(VAPID_ENV.privateKey);
  if (subject === '') missing.push(VAPID_ENV.subject);
  if (missing.length > 0) return { enabled: false, missing, problem: null };

  const problem = vapidKeyProblem(publicKey, privateKey, subject);
  if (problem !== null) return { enabled: false, missing: [], problem };
  return { enabled: true, keys: { publicKey, privateKey, subject } };
}

function vapidKeyProblem(publicKey: string, privateKey: string, subject: string): string | null {
  const pub = decodeBase64Url(publicKey);
  if (pub?.length !== 65 || pub[0] !== 0x04) {
    return `${VAPID_ENV.publicKey} must be an uncompressed P-256 public key (65 bytes, base64url)`;
  }
  const priv = decodeBase64Url(privateKey);
  if (priv?.length !== 32) {
    return `${VAPID_ENV.privateKey} must be a P-256 private key (32 bytes, base64url)`;
  }
  if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
    return `${VAPID_ENV.subject} must start with mailto: or https://`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Null for anything that is not base64url (padding tolerated). */
export function decodeBase64Url(value: string): Uint8Array | null {
  const unpadded = value.replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]*$/.test(unpadded)) return null;
  return new Uint8Array(Buffer.from(unpadded, 'base64url'));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** WebCrypto wants an ArrayBuffer-backed view; a copy guarantees one. */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** A P-256 key as a JWK: the public point, and the private scalar when given. */
function p256Jwk(publicKey: Uint8Array, privateKey?: Uint8Array): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: encodeBase64Url(publicKey.slice(1, 33)),
    y: encodeBase64Url(publicKey.slice(33, 65)),
    ...(privateKey !== undefined ? { d: encodeBase64Url(privateKey) } : {}),
    ext: true,
  };
}

/** An ECDH key pair and its public point in the uncompressed form push uses. */
export interface EcdhKeyPair {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

export async function generateEcdhKeyPair(): Promise<EcdhKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: raw };
}

/** An existing ECDH key pair — for the RFC's worked example, which fixes it. */
export async function importEcdhKeyPair(
  publicKey: Uint8Array,
  privateKey: Uint8Array
): Promise<EcdhKeyPair> {
  const key = await crypto.subtle.importKey(
    'jwk',
    p256Jwk(publicKey, privateKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
  return { privateKey: key, publicKey };
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// Payload encryption (RFC 8291)
// ---------------------------------------------------------------------------

/** One record holds the whole payload; notifications are far below this. */
const RECORD_SIZE = 4096;

/**
 * A browser's subscription keys as bytes: an uncompressed P-256 point and a
 * non-empty auth secret, or null when they cannot be encrypted to. The
 * subscribe route refuses what this refuses, so a stored subscription never
 * fails every push for a reason no retry can fix.
 */
export function readSubscriptionKeys(keys: {
  p256dh: string;
  auth: string;
}): { uaPublic: Uint8Array; authSecret: Uint8Array } | null {
  const uaPublic = decodeBase64Url(keys.p256dh);
  const authSecret = decodeBase64Url(keys.auth);
  if (uaPublic?.length !== 65 || authSecret === null || authSecret.length === 0) return null;
  return { uaPublic, authSecret };
}

/**
 * Encrypt `plaintext` to a browser's subscription keys, as one `aes128gcm`
 * record with its header. `salt` and `local` are fixed only by the RFC test;
 * every real push draws fresh ones.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  subscription: { p256dh: string; auth: string },
  fixed?: { salt: Uint8Array; local: EcdhKeyPair }
): Promise<Uint8Array> {
  const keys = readSubscriptionKeys(subscription);
  if (keys === null) throw new Error('Push subscription keys are malformed');
  const { uaPublic, authSecret } = keys;
  if (plaintext.length + 1 + 16 > RECORD_SIZE) {
    throw new Error(`Push payload is ${String(plaintext.length)} bytes; the limit is one record`);
  }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const local = fixed?.local ?? (await generateEcdhKeyPair());

  const uaKey = await crypto.subtle.importKey(
    'jwk',
    p256Jwk(uaPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256)
  );

  const keyInfo = concat(utf8('WebPush: info\0'), uaPublic, local.publicKey);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the last (and only) record; no padding.
  const record = concat(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, aesKey, buf(record))
  );

  const header = new Uint8Array(16 + 4 + 1 + local.publicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = local.publicKey.length;
  header.set(local.publicKey, 21);
  return concat(header, ciphertext);
}

// ---------------------------------------------------------------------------
// VAPID (RFC 8292)
// ---------------------------------------------------------------------------

/** How long a signed VAPID token is good for; the RFC caps it at 24 hours. */
const VAPID_TTL_SECONDS = 12 * 60 * 60;

/** The `Authorization` header value for a push to `endpoint`. */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  const publicKey = decodeBase64Url(keys.publicKey);
  const privateKey = decodeBase64Url(keys.privateKey);
  if (publicKey === null || privateKey === null) throw new Error('VAPID keys are malformed');
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    p256Jwk(publicKey, privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const header = encodeBase64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = encodeBase64Url(
    utf8(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: nowSeconds + VAPID_TTL_SECONDS,
        sub: keys.subject,
      })
    )
  );
  const unsigned = `${header}.${claims}`;
  // WebCrypto's ECDSA signature is already the raw r||s a JWT wants.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, buf(utf8(unsigned)))
  );
  return `vapid t=${unsigned}.${encodeBase64Url(signature)}, k=${keys.publicKey}`;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** How long the push service may hold a message for a phone that is off. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

/**
 * What the push service said. `gone` means the subscription no longer exists
 * (404 or 410) and should be forgotten; every other failure is kept, because a
 * push service having a bad minute is not the browser unsubscribing.
 */
export type PushDelivery =
  | { outcome: 'delivered' }
  | { outcome: 'gone'; status: number }
  | { outcome: 'failed'; status: number | null; detail: string };

export async function sendWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  keys: VapidKeys,
  fetchImpl: typeof fetch = fetch
): Promise<PushDelivery> {
  let body: Uint8Array;
  let authorization: string;
  try {
    body = await encryptPayload(utf8(payload), subscription);
    authorization = await vapidAuthorization(subscription.endpoint, keys);
  } catch (e) {
    return { outcome: 'failed', status: null, detail: (e as Error).message };
  }
  let res: Response;
  try {
    res = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: 'high',
      },
      body: buf(body),
    });
  } catch (e) {
    return { outcome: 'failed', status: null, detail: (e as Error).message };
  }
  if (res.ok) return { outcome: 'delivered' };
  if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status };
  const detail = (await res.text().catch(() => '')).slice(0, 200);
  return { outcome: 'failed', status: res.status, detail };
}
