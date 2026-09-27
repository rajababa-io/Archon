import { beforeEach, describe, expect, test } from 'bun:test';
import {
  checkHumanPass,
  resetHumanPassCache,
  verifyAccessToken,
  type KeyFetcher,
} from './human-pass';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-for-archon';
const ENV = { ARCHON_CF_ACCESS_TEAM_DOMAIN: TEAM, ARCHON_CF_ACCESS_AUD: AUD };

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: { kid: string; kty: string; n: string; e: string };
}

async function makeKey(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kid, kty: 'RSA', n: exported.n ?? '', e: exported.e ?? '' },
  };
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const json64 = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function sign(key: SigningKey, claims: Record<string, unknown>): Promise<string> {
  const head = json64({ alg: 'RS256', kid: key.kid, typ: 'JWT' });
  const body = json64(claims);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(`${head}.${body}`)
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

const NOW = 1_790_000_000;
const personClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  aud: [AUD],
  iss: `https://${TEAM}`,
  email: 'you@example.com',
  exp: NOW + 600,
  nbf: NOW - 10,
  ...overrides,
});

let teamKey: SigningKey;
let otherKey: SigningKey;
let fetcher: KeyFetcher;

beforeEach(async () => {
  resetHumanPassCache();
  teamKey ??= await makeKey('team-key');
  otherKey ??= await makeKey('team-key'); // same kid, different key: a forgery
  fetcher = async () => [teamKey.jwk];
});

describe('verifyAccessToken', () => {
  const config = { teamDomain: TEAM, audience: AUD };

  test('a pass Cloudflare signed for this app names the person', async () => {
    const token = await sign(teamKey, personClaims());
    expect(await verifyAccessToken(token, config, fetcher, NOW)).toEqual({
      email: 'you@example.com',
    });
  });

  test('a pass signed with any other key is refused, even under the right kid', async () => {
    const token = await sign(otherKey, personClaims());
    expect(await verifyAccessToken(token, config, fetcher, NOW)).toBeNull();
  });

  test('a pass for another Access application is refused', async () => {
    const token = await sign(teamKey, personClaims({ aud: ['some-other-app'] }));
    expect(await verifyAccessToken(token, config, fetcher, NOW)).toBeNull();
  });

  test('a pass from another team is refused', async () => {
    const token = await sign(teamKey, personClaims({ iss: 'https://evil.cloudflareaccess.com' }));
    expect(await verifyAccessToken(token, config, fetcher, NOW)).toBeNull();
  });

  test('an expired pass is refused', async () => {
    const token = await sign(teamKey, personClaims({ exp: NOW - 1 }));
    expect(await verifyAccessToken(token, config, fetcher, NOW)).toBeNull();
  });

  test('a service token passes Access but is not a person, and is refused', async () => {
    const claims = personClaims();
    delete claims.email;
    const token = await sign(teamKey, claims);
    expect(await verifyAccessToken(token, config, fetcher, NOW)).toBeNull();
  });

  test('an unsigned token is refused without asking for keys', async () => {
    const head = json64({ alg: 'none', kid: 'team-key' });
    let asked = false;
    const counting: KeyFetcher = async () => {
      asked = true;
      return [teamKey.jwk];
    };
    expect(
      await verifyAccessToken(`${head}.${json64(personClaims())}.`, config, counting, NOW)
    ).toBeNull();
    expect(asked).toBe(false);
  });

  test('an unknown kid asks for the keys again, so a rotation is not a refusal', async () => {
    const rotated = await makeKey('rotated-key');
    let calls = 0;
    const rotating: KeyFetcher = async () => {
      calls += 1;
      return calls === 1 ? [teamKey.jwk] : [teamKey.jwk, rotated.jwk];
    };
    expect(
      await verifyAccessToken(await sign(teamKey, personClaims()), config, rotating, NOW)
    ).not.toBeNull();
    expect(
      await verifyAccessToken(await sign(rotated, personClaims()), config, rotating, NOW)
    ).not.toBeNull();
    expect(calls).toBe(2);
  });
});

describe('checkHumanPass', () => {
  test('refuses everything when Access is not configured, and says so', async () => {
    const token = await sign(teamKey, personClaims());
    expect(await checkHumanPass(token, { env: {}, fetcher })).toEqual({
      ok: false,
      reason: 'not-configured',
    });
  });

  test('a request without the header — an agent on the loopback port — is refused', async () => {
    expect(await checkHumanPass(undefined, { env: ENV, fetcher })).toEqual({
      ok: false,
      reason: 'no-pass',
    });
  });

  test('a key endpoint that cannot be reached is a refusal, not a pass', async () => {
    const failing: KeyFetcher = async () => {
      throw new Error('offline');
    };
    const token = await sign(teamKey, {
      ...personClaims(),
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    expect(await checkHumanPass(token, { env: ENV, fetcher: failing })).toEqual({
      ok: false,
      reason: 'invalid-pass',
    });
  });
});
