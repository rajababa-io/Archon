/**
 * Zod schemas for the per-project deploy routes (`routes/project-deploy.ts`)
 * that the console reads through the generated API types.
 */
import { z } from '@hono/zod-openapi';
import { DEPLOY_LOG_KINDS } from '../../services/deploy-log-kinds';

/** Path params for `/api/projects/:projectId/deploy…`. */
export const projectIdParamsSchema = z.object({ projectId: z.string() });

/** One entry in a project's deploy log. */
export const deployLogEntrySchema = z
  .object({
    at: z.string(),
    kind: z.enum(DEPLOY_LOG_KINDS),
    actor: z.string().nullable(),
    sha: z.string().nullable(),
    detail: z.string().nullable(),
  })
  .openapi('DeployLogEntry');

/** GET /api/projects/:projectId/deploy/log — newest first. */
export const deployLogResponseSchema = z
  .object({ entries: z.array(deployLogEntrySchema) })
  .openapi('DeployLogResponse');

/**
 * GET /api/projects/:projectId/deploy/branches — the repository's branches for
 * the deploy pickers (#267). `reason` says why the list is empty when GitHub
 * could not be read; the picker then takes a typed name.
 */
export const deployBranchesResponseSchema = z
  .object({
    branches: z.array(z.string()),
    defaultBranch: z.string().nullable(),
    complete: z.boolean(),
    reason: z.string().nullable(),
  })
  .openapi('DeployBranchesResponse');
