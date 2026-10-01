/**
 * Zod schemas for the project artifact index (`routes/project-artifacts.ts`, #351).
 */
import { z } from '@hono/zod-openapi';
import { workflowRunStatusSchema } from './workflow.schemas';

/**
 * What kind of document an artifact is. Read off the path a workflow wrote it
 * to (or, for `handoff`, off the handoff record) — never off its contents.
 * `other` is a document that matches no convention; it is listed, and no
 * filter selects it.
 */
export const projectArtifactTypeSchema = z
  .enum(['plan', 'investigation', 'review', 'handoff', 'data', 'other'])
  .openapi('ProjectArtifactType');

/** The chat an artifact came from, with its two stored marks. */
export const projectArtifactChatSchema = z
  .object({
    /** Platform conversation id — what the console's chat rail keys rows by. */
    id: z.string(),
    title: z.string().nullable(),
    done: z.boolean(),
    ready: z.boolean(),
  })
  .openapi('ProjectArtifactChat');

export const projectArtifactSchema = z
  .object({
    /** Stable across loads: `run:<runId>:<path>` or `handoff:<messageId>`. */
    id: z.string(),
    type: projectArtifactTypeSchema,
    /** File name alone, for the row. */
    name: z.string(),
    modifiedAt: z.string(),
    /** Set for a run artifact: read it with `GET /api/artifacts/{runId}/{path}`. */
    run: z
      .object({
        id: z.string(),
        path: z.string(),
        workflowName: z.string(),
        status: workflowRunStatusSchema,
        /** From the run's `.pr-number` / `.pr-url`, when the workflow wrote them. */
        prNumber: z.number().int().nullable(),
        prUrl: z.string().nullable(),
      })
      .nullable(),
    /** Set for a handoff: read it with `GET /api/codebases/{id}/handoffs/{handoffId}`. */
    handoffId: z.string().nullable(),
    chat: projectArtifactChatSchema.nullable(),
  })
  .openapi('ProjectArtifact');

export const projectArtifactsResponseSchema = z
  .object({ artifacts: z.array(projectArtifactSchema) })
  .openapi('ProjectArtifactsResponse');

export const handoffDocumentSchema = z
  .object({ name: z.string(), content: z.string() })
  .openapi('HandoffDocument');
