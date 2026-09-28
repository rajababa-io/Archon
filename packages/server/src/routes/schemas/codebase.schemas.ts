/**
 * Zod schemas for codebase API endpoints.
 */
import { z } from '@hono/zod-openapi';
import { codebaseRowSchema } from '@archon/core/schemas/codebase';

/** A codebase record (wire shape with ISO string dates). */
export const codebaseSchema = codebaseRowSchema
  .extend({
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi('Codebase');

/** GET /api/codebases response. */
export const codebaseListResponseSchema = z.array(codebaseSchema).openapi('CodebaseListResponse');

/** Path params for routes with :id (codebase ID). */
export const codebaseIdParamsSchema = z.object({ id: z.string() });

/** POST /api/codebases request body. Exactly one of url or path must be provided. */
export const addCodebaseBodySchema = z
  .object({
    url: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .refine(b => (b.url !== undefined) !== (b.path !== undefined), {
    message: 'Provide either "url" or "path", not both and not neither',
  })
  .openapi('AddCodebaseBody');

/**
 * A git remote, as git itself would accept one.
 *
 * NOT `z.string().url()`. The scp-like form — `git@github.com:owner/repo.git` —
 * has no scheme and fails that check, and it is the form `resolveIssueSource`
 * already reads (`/github\.com[/:]/`). Rejecting it here would refuse a value
 * the rest of the system handles.
 *
 * Syntax only. Reachability is deliberately NOT probed: a private repository
 * whose token is configured later is a legitimate state, and it is exactly the
 * setup order this route exists to rescue — a reachability gate would refuse
 * the correction and leave the row wrong.
 */
const REMOTE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/[^\s/]+\/\S+|[^\s@]+@[^\s:]+:\S+)$/i;

export const remoteUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine(v => REMOTE_URL.test(v), {
    message:
      'Must be a git remote URL, e.g. https://github.com/owner/repo or git@github.com:owner/repo.git',
  });

/**
 * PATCH /api/codebases/:id request body.
 *
 * `repository_url` is `.nullable().optional()` so the route can tell "not
 * supplied" from "set to null" — clearing the field is a real operation and
 * must not be indistinguishable from leaving it alone. `updateCodebase`
 * already draws that line on `undefined`; this preserves it across the wire.
 *
 * Only `repository_url`. `default_cwd` has the same fill-only defect but
 * moving it would re-point a live working tree, which this route must never
 * do as a side effect; `default_branch` is deferred with it rather than
 * shipped half-considered.
 */
export const updateCodebaseBodySchema = z
  .object({
    repository_url: remoteUrlSchema.nullable().optional(),
  })
  .refine(b => b.repository_url !== undefined, {
    message: 'Nothing to update: supply "repository_url"',
  })
  .openapi('UpdateCodebaseBody');

/** DELETE /api/codebases/:id response. */
export const deleteCodebaseResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('DeleteCodebaseResponse');

/** Response for GET /api/codebases/:id/env — returns only keys, never values */
export const codebaseEnvVarsResponseSchema = z
  .object({
    keys: z.array(z.string()),
  })
  .openapi('CodebaseEnvVarsResponse');

/** Body for PUT /api/codebases/:id/env — upsert one key-value pair */
export const setEnvVarBodySchema = z
  .object({
    key: z.string().min(1).max(255),
    value: z.string(),
  })
  .openapi('SetEnvVarBody');

/** Path params for routes with :id/:key */
export const codebaseEnvVarParamsSchema = z.object({
  id: z.string(),
  key: z.string(),
});

/** Response for PUT/DELETE /api/codebases/:id/env */
export const envVarMutationResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('EnvVarMutationResponse');

// =========================================================================
// Files tab — reading a project's checkout (#23)
// =========================================================================

/**
 * `?path=` rather than a wildcard route. A wildcard is not representable in
 * OpenAPI, which is why the artifact route had to drop out of the generated
 * types; a query parameter keeps these two endpoints on the typed path and in
 * `api.generated.d.ts`.
 *
 * Empty means the project root. The server owns validation — a path is
 * caller-supplied input, so nothing here is trusted beyond "it is a string".
 */
export const codebaseFilePathQuerySchema = z.object({ path: z.string().optional() });

/**
 * One directory entry. `size` is null for anything that is not a regular file,
 * because a directory's byte size answers a question nobody asked.
 */
export const codebaseFileEntrySchema = z
  .object({
    name: z.string(),
    kind: z.enum(['file', 'dir', 'other']),
    size: z.number().nullable(),
  })
  .openapi('CodebaseFileEntry');

/** Response for GET /api/codebases/:id/files — one directory level, never a walk. */
export const codebaseFilesResponseSchema = z
  .object({
    /** Normalised path of the directory listed, relative to the project root. */
    path: z.string(),
    entries: z.array(codebaseFileEntrySchema),
  })
  .openapi('CodebaseFilesResponse');

/**
 * Response for GET /api/codebases/:id/paths — every file in the checkout, for
 * a search box. `truncated` says the list stopped at the server's ceiling, so a
 * search that finds nothing can say it may not have seen everything.
 */
export const codebasePathsResponseSchema = z
  .object({
    paths: z.array(z.string()),
    truncated: z.boolean(),
  })
  .openapi('CodebasePathsResponse');

/**
 * Version token for a file's contents, echoed back on write.
 *
 * A content hash, NOT an mtime: two writes inside one filesystem timestamp
 * tick are indistinguishable by time, and a clock that moves backwards makes
 * a stale file look fresh. The hash answers the only question a save needs to
 * ask - "is this still the file I read?"
 */
/** Response for GET /api/codebases/:id/file — one file's text. */
export const codebaseFileResponseSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    size: z.number(),
    etag: z.string(),
  })
  .openapi('CodebaseFileResponse');

/** Body for PUT /api/codebases/:id/file - the new text, and the version it replaces. */
export const writeCodebaseFileBodySchema = z
  .object({
    content: z.string(),
    /**
     * The `etag` from the read this edit started from. Required, never
     * optional: an absent token would make "save anyway" the default, and
     * the whole point of this endpoint is that it cannot silently overwrite.
     */
    etag: z.string().min(1),
  })
  .openapi('WriteCodebaseFileBody');

/** Response for PUT /api/codebases/:id/file - the state the file is now in. */
export const writeCodebaseFileResponseSchema = z
  .object({
    path: z.string(),
    size: z.number(),
    etag: z.string(),
  })
  .openapi('WriteCodebaseFileResponse');
