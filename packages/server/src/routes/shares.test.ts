/**
 * Share links (#345), through the real registrations. What matters: a `link`
 * share serves its page and the files below it to a request with no
 * credentials; every miss — unknown code, restricted share, a path that climbs
 * — is the same 404; and the API refuses to share what is not published.
 *
 * The share table is in memory; the files and the path rules are real.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';

mock.module('@archon/paths', () => ({
  createLogger: () => ({ fatal() {}, error() {}, warn() {}, info() {}, debug() {}, trace() {} }),
  getArchonPublicPath: () => {
    throw new Error('tests pass the root explicitly');
  },
}));

type Access = 'link' | 'restricted';
const byPath = new Map<string, { code: string; path: string; access: Access }>();
let next = 0;
const row = (s: { code: string; path: string; access: Access }) => ({
  ...s,
  createdAt: new Date(),
  updatedAt: new Date(),
});
mock.module('@archon/core/db/shares', () => ({
  getShare: async (code: string) => {
    for (const s of byPath.values()) if (s.code === code) return row(s);
    return null;
  },
  getShareByPath: async (path: string) => {
    const s = byPath.get(path);
    return s ? row(s) : null;
  },
  setShareAccess: async (path: string, access: Access) => {
    const s = byPath.get(path) ?? { code: `code${++next}`, path, access };
    s.access = access;
    byPath.set(path, s);
    return row(s);
  },
}));

const { registerShareApiRoutes, registerShareServing } = await import('./shares');
const { validationErrorHook } = await import('./openapi-defaults');

let base = '';
let app: OpenAPIHono;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'archon-shares-'));
  const root = join(base, 'public');
  await mkdir(join(root, 'archon', 'deck', 'img'), { recursive: true });
  await writeFile(join(root, 'archon', 'deck', 'index.html'), '<h1>deck</h1>');
  await writeFile(join(root, 'archon', 'deck', 'img', 'a.png'), 'PNG');
  await writeFile(join(root, 'archon', 'other.txt'), 'OTHER');
  app = new OpenAPIHono({ defaultHook: validationErrorHook });
  registerShareApiRoutes(app, root);
  registerShareServing(app, root);
  // The SPA catch-all the real server registers after these.
  app.get('*', c => c.text('SPA', 200));
});

afterAll(async () => {
  await removeTempTree(base);
});

const get = async (path: string): Promise<Response> => app.request(path);
const put = async (body: unknown): Promise<Response> =>
  app.request('/api/shares', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('share links', () => {
  test('sharing a folder hands back a slash-ended address that serves its page and files', async () => {
    const res = await put({
      path: 'https://archon.example.com/files/archon/deck/',
      access: 'link',
    });
    expect(res.status).toBe(200);
    const { share } = (await res.json()) as {
      share: { code: string; path: string; address: string };
    };
    expect(share.path).toBe('archon/deck');
    expect(share.address).toBe(`/share/${share.code}/`);

    const page = await get(share.address);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<h1>deck</h1>');
    expect(page.headers.get('Cache-Control')).toBe('no-cache');
    expect(page.headers.get('X-Robots-Tag')).toContain('noindex');

    expect(await (await get(`${share.address}img/a.png`)).text()).toBe('PNG');

    const bare = await get(`/share/${share.code}`);
    expect(bare.status).toBe(301);
    expect(bare.headers.get('Location')).toBe(share.address);

    const looked = await get('/api/shares?path=/files/archon/deck');
    expect(((await looked.json()) as { share: { code: string } }).share.code).toBe(share.code);
  });

  test('every miss is the same 404, never the SPA and never a file outside the share', async () => {
    const { share } = (await (await put({ path: 'archon/deck', access: 'link' })).json()) as {
      share: { code: string };
    };
    for (const path of [
      '/share/unknowncode/',
      '/share/bad!code/',
      `/share/${share.code}/%2e%2e/other.txt`,
      `/share/${share.code}/..%2fother.txt`,
      `/share/${share.code}/missing.png`,
    ]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Not found');
    }
  });

  test('restricting a share stops its address on the next request, and re-sharing keeps it', async () => {
    const on = (await (await put({ path: 'archon/deck', access: 'link' })).json()) as {
      share: { code: string; address: string };
    };
    const off = (await (await put({ path: 'archon/deck', access: 'restricted' })).json()) as {
      share: { code: string; access: string };
    };
    expect(off.share).toMatchObject({ code: on.share.code, access: 'restricted' });
    expect((await get(on.share.address)).status).toBe(404);

    await put({ path: 'archon/deck', access: 'link' });
    expect((await get(on.share.address)).status).toBe(200);
  });

  test('sharing a web page shares its folder, so the page loads what sits beside it', async () => {
    const res = await put({ path: '/files/archon/deck/index.html', access: 'link' });
    const { share } = (await res.json()) as {
      share: { code: string; path: string; address: string };
    };
    expect(share.path).toBe('archon/deck');
    expect(share.address).toBe(`/share/${share.code}/`);
    expect(await (await get(`${share.address}img/a.png`)).text()).toBe('PNG');
    const looked = (await (await get('/api/shares?path=/files/archon/deck/index.html')).json()) as {
      share: { code: string };
    };
    expect(looked.share.code).toBe(share.code);
  });

  test('the API refuses to share what is not published, or a path that climbs', async () => {
    expect((await put({ path: '/files/archon/nope', access: 'link' })).status).toBe(400);
    expect((await put({ path: '/files/../etc', access: 'link' })).status).toBe(400);
    expect((await get('/api/shares?path=/files/archon/never')).status).toBe(200);
    expect(await (await get('/api/shares?path=/files/archon/never')).json()).toEqual({
      share: null,
    });
  });
});
