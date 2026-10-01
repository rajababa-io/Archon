/**
 * Zod schemas for a project's pictures (`routes/project-pictures.ts`), read by
 * the console's Pictures band and gallery through the generated API types.
 */
import { z } from '@hono/zod-openapi';

export const picturesParamsSchema = z.object({ projectId: z.string() });

export const picturesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(8),
  offset: z.coerce.number().int().min(0).default(0),
  /** Only pictures in this topic folder. */
  topic: z.string().min(1).optional(),
});

export const pictureSchema = z
  .object({
    path: z.string(),
    topic: z.string().nullable(),
    name: z.string(),
    url: z.string(),
    thumbUrl: z.string().nullable(),
    modifiedAt: z.string(),
    bytes: z.number(),
  })
  .openapi('ProjectPicture');

export const pictureTopicSchema = z
  .object({ name: z.string(), count: z.number(), latestAt: z.string() })
  .openapi('ProjectPictureTopic');

/** GET /api/projects/:projectId/pictures — newest first. */
export const picturesResponseSchema = z
  .object({
    all: z.number(),
    total: z.number(),
    topics: z.array(pictureTopicSchema),
    pictures: z.array(pictureSchema),
  })
  .openapi('ProjectPicturesResponse');
