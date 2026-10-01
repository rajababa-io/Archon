/**
 * Share links (#345).
 *
 *   GET /share/<code>/...   the shared page or file, to anyone, while access is `link`
 *   GET /api/shares?path=   the share for one published path, or null
 *   PUT /api/shares         set a path's access, issuing its code the first time
 *
 * `/share/` is the one prefix the operator lets past the deployment's login,
 * so its handler is written for an anonymous requester: it serves only what a
 * share row names, only below that path, and answers every miss — no such
 * code, a restricted share, a path that climbs — with the same 404.
 *
 * The API is NOT public. It sits under `/api/`, behind the same gate as every
 * other console route; only the address it hands out is meant to be passed on.
 */
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import * as sharesDb from '@archon/core/db/shares';
import {
  normalizeSharePath,
  resolveShareRequest,
  shareTarget,
  targetAddress,
  type ShareTarget,
} from '@archon/core/services/shares';
import { createLogger, getArchonPublicPath } from '@archon/paths';
import { errorSchema } from './schemas/common.schemas';
import {
  shareChangeSchema,
  shareLookupQuerySchema,
  shareLookupSchema,
  shareResultSchema,
} from './schemas/shares.schemas';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('shares');
  return cachedLog;
}

const json = <T>(schema: T, description: string) =>
  ({ content: { 'application/json': { schema } }, description }) as const;

function present(
  share: sharesDb.Share,
  target: Pick<ShareTarget, 'kind' | 'page'>
): { code: string; path: string; access: sharesDb.ShareAccess; address: string } {
  return {
    code: share.code,
    path: share.path,
    access: share.access,
    address: targetAddress(share.code, target),
  };
}

/**
 * The address shape for a path with nothing published at it any more, so a
 * share whose files were deleted can still be found and turned off.
 */
const BARE = { kind: 'file', page: '' } as const;

const lookupRoute = createRoute({
  method: 'get',
  path: '/api/shares',
  tags: ['Shares'],
  summary: 'The share for one published path',
  request: { query: shareLookupQuerySchema },
  responses: {
    200: json(shareLookupSchema, 'The share, or null when the path was never shared'),
    400: json(errorSchema, 'Not a path under the public files root'),
  },
});

const changeRoute = createRoute({
  method: 'put',
  path: '/api/shares',
  tags: ['Shares'],
  summary: "Set a published path's access, issuing its share code the first time",
  request: {
    body: { content: { 'application/json': { schema: shareChangeSchema } }, required: true },
  },
  responses: {
    200: json(shareResultSchema, 'The share after the change'),
    400: json(errorSchema, 'Not a published file or folder'),
  },
});

export function registerShareApiRoutes(app: OpenAPIHono, root?: string): void {
  const publicRoot = root ?? getArchonPublicPath();

  app.openapi(lookupRoute, async c => {
    const normalized = normalizeSharePath(c.req.valid('query').path);
    if (!normalized.ok) return c.json({ error: normalized.reason }, 400);
    const target = await shareTarget(publicRoot, normalized.path);
    const share = await sharesDb.getShareByPath(target?.path ?? normalized.path);
    return c.json({ share: share ? present(share, target ?? BARE) : null }, 200);
  });

  app.openapi(changeRoute, async c => {
    const { path, access } = c.req.valid('json');
    const normalized = normalizeSharePath(path);
    if (!normalized.ok) return c.json({ error: normalized.reason }, 400);
    const target = await shareTarget(publicRoot, normalized.path);
    // Turning a share OFF must work even after its files are gone; turning one
    // on needs something there to serve.
    if (target === null && access === 'link') {
      return c.json({ error: `nothing is published at /files/${normalized.path}` }, 400);
    }
    const share = await sharesDb.setShareAccess(target?.path ?? normalized.path, access);
    getLog().info({ code: share.code, path: share.path, access }, 'share.access_set');
    return c.json({ share: present(share, target ?? BARE) }, 200);
  });
}

/**
 * Codes are base64url. Anything else cannot be one, so it is a 404 without a
 * database read — the prefix is public, and a cheap miss keeps it that way.
 */
const CODE = /^[A-Za-z0-9_-]{1,32}$/;

export function registerShareServing(app: OpenAPIHono, root?: string): void {
  const publicRoot = root ?? getArchonPublicPath();
  const notFound = (c: Context): Response => c.text('Not found', 404);

  const serve = async (c: Context): Promise<Response> => {
    const code = c.req.param('code') ?? '';
    if (!CODE.test(code)) return notFound(c);
    const share = await sharesDb.getShare(code);
    if (share === null) return notFound(c);

    // The raw, still-encoded path: decoding is the resolver's job, so an
    // encoded `..` is judged after decoding, not slipped past it.
    const pathname = new URL(c.req.url).pathname;
    const after = pathname.slice(`/share/${code}`.length);
    const resolution = await resolveShareRequest(
      publicRoot,
      share,
      after.replace(/^\//, ''),
      after.startsWith('/')
    );
    if (resolution.kind === 'redirect') return c.redirect(resolution.location, 301);
    if (resolution.kind === 'missing') return notFound(c);

    const file = Bun.file(resolution.file);
    return new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        // A re-published file keeps its address; the next request must see it.
        'Cache-Control': 'no-cache',
        // Shared for the people it was sent to, not for search engines.
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      },
    });
  };

  app.get('/share/:code', serve);
  app.get('/share/:code/*', serve);
}
