/**
 * Zod schemas for the slash-command listing the console's `/` menu reads.
 */
import { z } from '@hono/zod-openapi';

export const slashCommandEntrySchema = z
  .object({
    /** What completing the entry inserts, e.g. `/workflow run`. */
    command: z.string(),
    /** Argument synopsis shown after the command, e.g. `<name> [message]`. Empty when none. */
    args: z.string(),
    description: z.string(),
  })
  .openapi('SlashCommandEntry');

export const slashWorkflowEntrySchema = z
  .object({
    name: z.string(),
    /** First line of the workflow's description, or null when it has none. */
    summary: z.string().nullable(),
  })
  .openapi('SlashWorkflowEntry');

export const slashCommandListResponseSchema = z
  .object({
    commands: z.array(slashCommandEntrySchema),
    workflows: z.array(slashWorkflowEntrySchema),
  })
  .openapi('SlashCommandListResponse');

export const slashCommandListQuerySchema = z.object({
  /** Project whose workflows to list. Omitted: bundled and home-scoped workflows only. */
  codebaseId: z.string().optional(),
});
