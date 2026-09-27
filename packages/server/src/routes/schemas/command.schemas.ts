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

export const slashProviderCommandEntrySchema = z
  .object({
    /** What the user types to run it, e.g. `/compact`, `$imagegen`, `/claude:status`. */
    command: z.string(),
    /** Argument synopsis as the provider reports it. Empty when none. */
    args: z.string(),
    description: z.string(),
    kind: z.enum(['skill', 'command']),
    /** Where it is defined: the provider's own, the user's, the project's, or elsewhere. */
    origin: z.enum(['provider', 'user', 'project', 'other']),
  })
  .openapi('SlashProviderCommandEntry');

export const slashProviderCommandsSchema = z
  .object({
    /** Registered provider id the chat's next message goes to. */
    id: z.string(),
    displayName: z.string(),
    commands: z.array(slashProviderCommandEntrySchema),
    /** Reported by the provider but not offered in a chat, each with the provider's reason. */
    withheld: z.array(z.object({ name: z.string(), reason: z.string() })),
    /** Set when the provider could not be asked; `commands` is then empty. */
    error: z.string().nullable(),
  })
  .openapi('SlashProviderCommands');

export const slashCommandListResponseSchema = z
  .object({
    commands: z.array(slashCommandEntrySchema),
    workflows: z.array(slashWorkflowEntrySchema),
    /** The chat's provider and its own commands. Null without a `conversationId`. */
    provider: slashProviderCommandsSchema.nullable(),
  })
  .openapi('SlashCommandListResponse');

export const slashCommandListQuerySchema = z.object({
  /** Project whose workflows to list. Omitted: bundled and home-scoped workflows only. */
  codebaseId: z.string().optional(),
  /** Chat whose provider commands to list (its platform conversation id). */
  conversationId: z.string().optional(),
});
