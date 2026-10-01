/**
 * GET /api/projects/:projectId/pictures — a project's published pictures,
 * newest first, with a thumbnail for each (#350). Which pictures are the
 * project's, and where thumbnails come from, is `services/project-pictures.ts`.
 *
 * Read-only and listing only: the bytes are served by the `/files/` route
 * (`public-files.ts`) as before, so this adds no way to read a file that was
 * not already public.
 */
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import * as codebaseDb from '@archon/core/db/codebases';
import { getArchonPublicPath } from '@archon/paths';
import { errorSchema } from './schemas/common.schemas';
import {
  picturesParamsSchema,
  picturesQuerySchema,
  picturesResponseSchema,
} from './schemas/pictures.schemas';
import { listProjectPictures, type ThumbnailMaker } from '../services/project-pictures';

const picturesRoute = createRoute({
  method: 'get',
  path: '/api/projects/{projectId}/pictures',
  tags: ['Pictures'],
  summary: "A project's published pictures, newest first, with thumbnails",
  request: { params: picturesParamsSchema, query: picturesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: picturesResponseSchema } },
      description: 'OK',
    },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'No project' },
  },
});

/**
 * `publicRoot` and `makeThumbnail` are injectable for the test only; production
 * reads ARCHON_HOME and uses sharp.
 */
export function registerProjectPicturesRoutes(
  app: OpenAPIHono,
  opts: { publicRoot?: string; makeThumbnail?: ThumbnailMaker } = {}
): void {
  app.openapi(picturesRoute, async c => {
    // Read per request, not at registration: resolving ARCHON_HOME probes for
    // Docker, and registering routes should not have side effects for the
    // routes registered beside it.
    const publicRoot = opts.publicRoot ?? getArchonPublicPath();
    const { projectId } = c.req.valid('param');
    const { limit, offset, topic } = c.req.valid('query');
    const codebase = await codebaseDb.getCodebase(projectId);
    if (codebase === null) return c.json({ error: 'Project not found' }, 404);
    const others = (await codebaseDb.listCodebases())
      .filter(cb => cb.id !== codebase.id)
      .map(cb => cb.name);
    const listing = await listProjectPictures({
      publicRoot,
      projectName: codebase.name,
      otherProjectNames: others,
      topic,
      limit,
      offset,
      makeThumbnail: opts.makeThumbnail,
    });
    return c.json(listing, 200);
  });
}
