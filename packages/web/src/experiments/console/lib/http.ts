/**
 * Tiny HTTP helpers owned by the console. Console skills use this boundary for
 * runtime API calls.
 */

const API_PORT = (import.meta.env.VITE_API_PORT as string | undefined) ?? '3090';

/**
 * SSE base URL. In dev, bypasses Vite proxy by connecting directly to the
 * backend (the proxy buffers SSE). In production, relative URLs (same origin).
 */
export const SSE_BASE_URL = import.meta.env.DEV
  ? `http://${window.location.hostname}:${API_PORT}`
  : '';

export class HttpError extends Error {
  readonly status: number;
  readonly path: string;
  /** The server error body — apiError's JSON `{error, detail?}`, capped at 200
   *  chars of content with a `...` suffix appended when cut off (so up to ~203
   *  chars, possibly mid-JSON). Consumers must guard `JSON.parse` and fall back
   *  to the raw text. */
  readonly bodySnippet: string;
  /** apiError's full `error` message, read from the whole body; undefined when the body
   *  is not apiError JSON. Operator-facing refusals are longer than the snippet. */
  readonly serverError: string | undefined;
  constructor(status: number, path: string, bodySnippet: string, serverError?: string) {
    super(`API error ${status.toString()} (${path}): ${bodySnippet}`);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
    this.bodySnippet = bodySnippet;
    this.serverError = serverError;
  }
}

/**
 * An API read that was answered with a redirect. Archon's API never redirects,
 * so the redirect came from an auth proxy in front of it (Cloudflare Access,
 * an OAuth gateway) whose sign-in has run out. Followed, it lands on the
 * proxy's login page on another origin and fails as a CORS error with no
 * status — indistinguishable from the server being down. Only a top-level
 * navigation can go through that login, so the remedy is reloading the page.
 */
export class SignInRequired extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `Sign-in needed: a proxy in front of Archon redirected ${path}. Reload the page to sign in.`
    );
    this.name = 'SignInRequired';
    this.path = path;
  }
}

/**
 * The path to name in an error. `window` is absent under the test runner, and
 * a helper that can only report a URL inside a browser is a helper whose error
 * paths never get tested - which is how both of them stayed untested here.
 */
function pathOf(url: string): string {
  const origin = globalThis.location?.origin ?? 'http://localhost';
  try {
    return new URL(url, origin).pathname;
  } catch {
    return url;
  }
}

function apiErrorMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      return typeof parsed.error === 'string' ? parsed.error : undefined;
    }
  } catch {
    // Not apiError JSON (a proxy page, an empty body); the snippet still carries it.
  }
  return undefined;
}

/**
 * The server's own message from a failed request: apiError's `{ error, detail? }`
 * body. `bodySnippet` is capped (see HttpError), so a long body may not parse;
 * the raw snippet is the fallback.
 */
export function serverErrorMessage(err: HttpError): string {
  let message = err.bodySnippet || `Request failed (${String(err.status)})`;
  try {
    const parsed = JSON.parse(err.bodySnippet) as { error?: string; detail?: string };
    if (parsed.error) {
      message = parsed.detail ? `${parsed.error}: ${parsed.detail}` : parsed.error;
    }
  } catch {
    /* truncated/non-JSON body — keep the raw snippet */
  }
  return message;
}

/** Best-effort human detail from a thrown error (the server message for an HttpError). */
export function errorDetail(e: unknown): string {
  if (e instanceof HttpError) return serverErrorMessage(e);
  if (e instanceof Error) return e.message;
  return String(e);
}

function mergeHeaders(
  base: Record<string, string>,
  extra: HeadersInit | undefined
): Record<string, string> {
  if (extra === undefined) return base;
  const out: Record<string, string> = { ...base };
  if (extra instanceof Headers) {
    extra.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(extra)) {
    for (const [k, v] of extra) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

export async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const needsJson = options?.body !== undefined && !(options.body instanceof FormData);
  const headers = mergeHeaders(
    needsJson ? { 'Content-Type': 'application/json' } : {},
    options?.headers
  );
  const res = await fetch(url, {
    credentials: 'same-origin',
    redirect: 'manual',
    ...options,
    headers,
  });
  if (res.type === 'opaqueredirect') throw new SignInRequired(pathOf(url));
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const truncated = body.length > 200 ? `${body.slice(0, 200)}...` : body;
    throw new HttpError(res.status, pathOf(url), truncated, apiErrorMessage(body));
  }
  // A 200 carrying text/html is the SPA fallback, which answers any path the
  // server does not route. Left to res.json() it surfaces as
  // "Unexpected token '<'", which reads like a parse bug in the data rather
  // than a missing route, and callers that treat any throw as "nothing here"
  // show an empty state instead. Naming it is the difference between an
  // afternoon and a minute.
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    throw new HttpError(
      res.status,
      pathOf(url),
      `expected JSON, got ${type === '' ? 'no content-type' : type}. This path is not routed by the server ` +
        '(the SPA fallback answered it), which usually means the server is older than this bundle.'
    );
  }
  return res.json() as Promise<T>;
}
