import { afterEach, describe, expect, test } from 'bun:test';
import { HttpError, SignInRequired, errorDetail, requestJson } from './http';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function reply(body: string, init: { status?: number; type?: string }): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(body, {
        status: init.status ?? 200,
        headers: init.type === undefined ? {} : { 'content-type': init.type },
      })
    )) as unknown as typeof fetch;
}

describe('requestJson', () => {
  test('parses a JSON response', async () => {
    reply('{"ok":true}', { type: 'application/json' });
    expect(await requestJson<{ ok: boolean }>('/api/thing')).toEqual({ ok: true });
  });

  test('a 200 of text/html is the SPA fallback, not data', async () => {
    // The exact shape that made a missing route look like an empty state: the
    // server does not route the path, so index.html comes back with a 200.
    reply('<!doctype html><html></html>', { type: 'text/html; charset=utf-8' });
    const err = await requestJson('/api/projects/abc/presentation').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).bodySnippet).toContain('not routed by the server');
    expect((err as HttpError).bodySnippet).toContain('older than this bundle');
  });

  test('names a missing content-type rather than printing "undefined"', async () => {
    reply('nope', {});
    const err = (await requestJson('/api/thing').catch((e: unknown) => e)) as HttpError;
    expect(err.bodySnippet).toContain('no content-type');
  });

  test('an auth proxy redirect is a sign-in error, not followed and not a network failure', async () => {
    // Followed, the redirect lands on the proxy's login page on another origin
    // and fails as a CORS TypeError — the same thing a dead server looks like.
    let seen: RequestInit | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return Promise.resolve({ type: 'opaqueredirect', ok: false, status: 0 } as Response);
    }) as unknown as typeof fetch;
    const err = await requestJson('/api/conversations').catch((e: unknown) => e);
    expect(seen?.redirect).toBe('manual');
    expect(err).toBeInstanceOf(SignInRequired);
    expect((err as SignInRequired).path).toBe('/api/conversations');
  });

  test('a non-2xx still reports its status and body', async () => {
    reply('{"error":"boom"}', { status: 500, type: 'application/json' });
    const err = (await requestJson('/api/thing').catch((e: unknown) => e)) as HttpError;
    expect(err.status).toBe(500);
    expect(err.bodySnippet).toContain('boom');
  });
});

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;

function respond(status: number, body: string): void {
  (globalThis as { window?: unknown }).window = { location: { origin: 'http://localhost' } };
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(body, { status }))) as typeof fetch;
}

async function caught(): Promise<HttpError> {
  try {
    await requestJson('/api/workflows/runs/r1/cancel', { method: 'POST' });
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('requestJson did not throw');
}

describe('requestJson errors', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  // A cancel refusal lists the recorded owner facts and runs past the 200-character
  // snippet; the console shows `serverError`, so it must be the whole message.
  test('carries the full apiError message beyond the snippet cap', async () => {
    const message = `No live owner answered for this run on this host.\n${'x'.repeat(300)}`;
    respond(409, JSON.stringify({ error: message }));

    const error = await caught();

    expect(error.status).toBe(409);
    expect(error.bodySnippet.length).toBeLessThan(message.length);
    expect(error.serverError).toBe(message);
  });

  test('leaves serverError undefined for a body that is not apiError JSON', async () => {
    respond(502, '<html>Bad gateway</html>');

    const error = await caught();

    expect(error.serverError).toBeUndefined();
    expect(error.bodySnippet).toBe('<html>Bad gateway</html>');
  });
});

describe('errorDetail', () => {
  test('HttpError → parsed server message', () => {
    const err = new HttpError(403, '/api/workflows/foo', JSON.stringify({ error: 'denied' }));
    expect(errorDetail(err)).toBe('denied');
  });

  test('generic Error → message; non-Error → String()', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom');
    expect(errorDetail(42)).toBe('42');
  });
});
