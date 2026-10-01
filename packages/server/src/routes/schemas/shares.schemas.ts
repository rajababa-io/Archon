/**
 * Zod schemas for the share-link endpoints (`routes/shares.ts`).
 */
import { z } from '@hono/zod-openapi';

export const shareAccessSchema = z.enum(['link', 'restricted']).openapi('ShareAccess');

export const shareSchema = z
  .object({
    code: z.string(),
    /** Relative to the public files root — what follows `/files/` in its private address. */
    path: z.string(),
    access: shareAccessSchema,
    /** Site-relative address the share answers at, e.g. `/share/<code>/`. */
    address: z.string(),
  })
  .openapi('Share');

/** GET /api/shares — the share for one path, or null when it was never shared. */
export const shareLookupQuerySchema = z.object({ path: z.string().min(1).max(2048) });
export const shareLookupSchema = z.object({ share: shareSchema.nullable() }).openapi('ShareLookup');

/** PUT /api/shares — set a path's access, issuing its code the first time. */
export const shareChangeSchema = z
  .object({ path: z.string().min(1).max(2048), access: shareAccessSchema })
  .openapi('ShareChange');
export const shareResultSchema = z.object({ share: shareSchema }).openapi('ShareResult');
