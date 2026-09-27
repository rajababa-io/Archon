/**
 * Whether a request came from a person signed in through Cloudflare Access.
 *
 * WHY THIS EXISTS (#211). Some console actions — flipping Deploy on Merge,
 * Deploy now, Cancel deploy — are a person's alone. Hiding the buttons from
 * agents is not enough: agents run in the same container as this server and
 * can send any HTTP request a browser can, with any header they like, straight
 * to the loopback port. `X-Archon-User` is exactly such a header.
 *
 * What an agent inside the box cannot produce is the JWT Cloudflare Access
 * signs and attaches as `Cf-Access-Jwt-Assertion` to every request that passed
 * its login. It is signed with the team's private key, and the only way to get
 * one is to complete that login in a browser. So these actions require that
 * header, verified against the team's published keys — signature, audience,
 * issuer and expiry.
 *
 * FAIL CLOSED. With `ARCHON_CF_ACCESS_TEAM_DOMAIN` or `ARCHON_CF_ACCESS_AUD`
 * unset, every human-only action is refused with a reason that names the
 * missing setting. An install without Access has no way to tell a person from
 * an agent, and saying so is better than quietly letting both through.
 */

import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('human-pass');
  return cachedLog;
}

export const HUMAN_PASS_HEADER = 'Cf-Access-Jwt-Assertion';

export type HumanPass =
  | { ok: true; email: string }
  | { ok: false; reason: 'not-configured' | 'no-pass' | 'invalid-pass' };

interface AccessConfig {
  teamDomain: string;
  audience: string;
}

function readConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig | null {
  const rawDomain = env.ARCHON_CF_ACCESS_TEAM_DOMAIN?.trim() ?? '';
  const audience = env.ARCHON_CF_ACCESS_AUD?.trim() ?? '';
  if (rawDomain === '' || audience === '') return null;
  // Accept `team.cloudflareaccess.com` or the full https URL; the issuer
  // Cloudflare writes into the token is always the https form.
  const teamDomain = rawDomain.replace(/^https?:\/\//u, '').replace(/\/+$/u, '');
  return { teamDomain, audience };
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

export type KeyFetcher = (teamDomain: string) => Promise<Jwk[]>;

/** How long the team's keys are trusted before being asked for again. */
const KEY_TTL_MS = 60 * 60 * 1000;
let keyCache: { teamDomain: string; keys: Jwk[]; fetchedAt: number } | undefined;

const fetchTeamKeys: KeyFetcher = async teamDomain => {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Access certs answered HTTP ${String(res.status)}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  return body.keys ?? [];
};

async function keysFor(
  teamDomain: string,
  fetcher: KeyFetcher,
  forceRefresh: boolean
): Promise<Jwk[]> {
  const now = Date.now();
  if (
    !forceRefresh &&
    keyCache?.teamDomain === teamDomain &&
    now - keyCache.fetchedAt < KEY_TTL_MS
  ) {
    return keyCache.keys;
  }
  const keys = await fetcher(teamDomain);
  keyCache = { teamDomain, keys, fetchedAt: now };
  return keys;
}

/** Test seam: forget cached keys. */
export function resetHumanPassCache(): void {
  keyCache = undefined;
}

function base64UrlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/gu, '+').replace(/_/gu, '/');
  return Uint8Array.from(Buffer.from(padded, 'base64'));
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Verify one token. Exported for tests; routes call {@link checkHumanPass}.
 */
export async function verifyAccessToken(
  token: string,
  config: AccessConfig,
  fetcher: KeyFetcher = fetchTeamKeys,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{ email: string } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];
  const header = decodeJson(headerSeg);
  const payload = decodeJson(payloadSeg);
  if (header === null || payload === null) return null;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

  // A key rotation shows up as an unknown kid; ask once more before refusing.
  let keys = await keysFor(config.teamDomain, fetcher, false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (jwk === undefined) {
    keys = await keysFor(config.teamDomain, fetcher, true);
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (jwk === undefined) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const signed = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(signatureSeg),
    signed
  );
  if (!valid) return null;

  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(config.audience)) return null;
  if (payload.iss !== `https://${config.teamDomain}`) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds + 60) return null;
  // A service token also passes Access, but it is a machine credential, not a
  // person — it carries no email, and is refused here for that reason.
  if (typeof payload.email !== 'string' || payload.email === '') return null;
  return { email: payload.email };
}

/**
 * The gate every human-only route calls first.
 *
 * `fetcher` and `env` are seams for tests; production passes neither.
 */
export async function checkHumanPass(
  headerValue: string | undefined,
  options: { env?: NodeJS.ProcessEnv; fetcher?: KeyFetcher } = {}
): Promise<HumanPass> {
  const config = readConfig(options.env);
  if (config === null) return { ok: false, reason: 'not-configured' };
  if (headerValue === undefined || headerValue === '') return { ok: false, reason: 'no-pass' };
  try {
    const verified = await verifyAccessToken(headerValue, config, options.fetcher);
    if (verified === null) return { ok: false, reason: 'invalid-pass' };
    return { ok: true, email: verified.email };
  } catch (err) {
    // Unreachable key endpoint: refused, and logged so it can be told apart
    // from a forged pass. The token itself is never logged.
    getLog().warn({ err }, 'human_pass.verify_failed');
    return { ok: false, reason: 'invalid-pass' };
  }
}

/** The sentence the console shows when a human-only action is refused. */
export function humanPassRefusal(reason: Exclude<HumanPass, { ok: true }>['reason']): string {
  switch (reason) {
    case 'not-configured':
      return 'Only a person signed in through Cloudflare Access can do this, and this install has no Access settings (ARCHON_CF_ACCESS_TEAM_DOMAIN, ARCHON_CF_ACCESS_AUD).';
    case 'no-pass':
      return 'Only a person signed in through Cloudflare Access can do this. This request did not come through Access.';
    case 'invalid-pass':
      return 'Only a person signed in through Cloudflare Access can do this. The Access pass on this request could not be verified.';
  }
}
