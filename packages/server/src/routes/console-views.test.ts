/**
 * The console tab-memory routes (#251). What matters: a choice is stored under
 * the person on the verified Access pass and read back only by that person; a
 * request with no pass, or a forged one, neither reads nor writes; and a stored
 * value this build does not know is left out rather than sent.
 *
 * The Access check is the real one; only the key endpoint is faked, by serving
 * the test's own "team" key where Cloudflare's would be.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal() {},
    error() {},
    warn() {},
    info() {},
    debug() {},
    trace() {},
  }),
}));

/** person → scope id → view: the table, in memory. */
const rows = new Map<string, Map<string, string>>();
const mockSet = mock(async (person: string, scopeId: string, view: string) => {
  const mine = rows.get(person) ?? new Map<string, string>();
  mine.set(scopeId, view);
  rows.set(person, mine);
});
mock.module('@archon/core/db/console-view-prefs', () => ({
  ALL_PROJECTS_SCOPE: '',
  readConsoleViews: async (person: string) => Object.fromEntries(rows.get(person) ?? []),
  setConsoleView: mockSet,
}));

const { registerConsoleViewRoutes } = await import('./console-views');
const { resetHumanPassCache } = await import('../services/human-pass');
const { validationErrorHook } = await import('./openapi-defaults');

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'archon-app';

let teamKey: CryptoKeyPair;
let agentKey: CryptoKeyPair;
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

const b64 = (v: unknown): string =>
  Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

async function pass(key: CryptoKey, email: string): Promise<string> {
  const head = b64({ alg: 'RS256', kid: 'k1' });
  const body = b64({
    aud: [AUD],
    iss: `https://${TEAM}`,
    email,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${head}.${body}`)
  );
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}

const rsa = (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );

beforeAll(async () => {
  teamKey = await rsa();
  agentKey = await rsa();
  const teamJwk = await crypto.subtle.exportKey('jwk', teamKey.publicKey);
  process.env.ARCHON_CF_ACCESS_TEAM_DOMAIN = TEAM;
  process.env.ARCHON_CF_ACCESS_AUD = AUD;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ kid: 'k1', kty: 'RSA', n: teamJwk.n, e: teamJwk.e }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  process.env = savedEnv;
});

beforeEach(() => {
  resetHumanPassCache();
  rows.clear();
  mockSet.mockClear();
});

function app(): OpenAPIHono {
  const a = new OpenAPIHono({ defaultHook: validationErrorHook });
  registerConsoleViewRoutes(a);
  return a;
}

const put = async (headers: Record<string, string>, body: unknown): Promise<Response> =>
  app().request('/api/console/views', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('console views', () => {
  test('a choice is stored under the signed-in person and read back by them only', async () => {
    const you = { 'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey, 'you@example.com') };
    const other = { 'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey, 'them@example.com') };

    const res = await put(you, { scopeId: '', view: 'chat' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ views: { '': 'chat' } });
    await put(you, { scopeId: 'proj-1', view: 'issues' });

    const mine = await app().request('/api/console/views', { headers: you });
    expect(await mine.json()).toEqual({ views: { '': 'chat', 'proj-1': 'issues' } });
    const theirs = await app().request('/api/console/views', { headers: other });
    expect(await theirs.json()).toEqual({ views: {} });
  });

  test('no pass, or one not signed by the team, neither reads nor writes', async () => {
    const forged = {
      'Cf-Access-Jwt-Assertion': await pass(agentKey.privateKey, 'you@example.com'),
    };
    const attempts: Record<string, string>[] = [{}, { 'X-Archon-User': 'you@example.com' }, forged];
    for (const headers of attempts) {
      expect((await put(headers, { scopeId: '', view: 'chat' })).status).toBe(401);
      expect((await app().request('/api/console/views', { headers })).status).toBe(401);
    }
    expect(mockSet).not.toHaveBeenCalled();
  });

  test('a tab this build does not know is refused on write and skipped on read', async () => {
    const you = { 'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey, 'you@example.com') };
    expect((await put(you, { scopeId: '', view: 'board' })).status).toBe(400);
    rows.set(
      'you@example.com',
      new Map([
        ['', 'board'],
        ['proj-1', 'runs'],
      ])
    );
    const res = await app().request('/api/console/views', { headers: you });
    expect(await res.json()).toEqual({ views: { 'proj-1': 'runs' } });
  });
});
