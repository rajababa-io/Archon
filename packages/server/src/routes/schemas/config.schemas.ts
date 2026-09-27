/**
 * Zod schemas for configuration API endpoints.
 */
import { z } from '@hono/zod-openapi';
import { MAX_CI_WAIT_ALARM_MINUTES } from '@archon/core/config/chats';
import { effortLevelSchema, rejectRetiredThinking } from '@archon/workflows/schemas/effort';

/** Schema for the safe config subset returned to web clients (mirrors SafeConfig in config-types.ts). */
const providerDefaultsSchema = z.record(z.string(), z.unknown()).openapi('ProviderDefaults');

/**
 * A single model-tier preset — mirrors `RawAliasEntry` in
 * `@archon/workflows/model-validation` ({ provider, model, effort? }).
 */
export const tierEntrySchema = z
  .preprocess(
    rejectRetiredThinking,
    z.object({
      provider: z.string().min(1),
      model: z.string().min(1),
      effort: effortLevelSchema.optional(),
    })
  )
  .openapi('TierEntry');

/** The three reserved tiers, each optional — mirrors `RawTiersConfig`. */
export const tiersConfigSchema = z
  .object({
    small: tierEntrySchema.optional(),
    medium: tierEntrySchema.optional(),
    large: tierEntrySchema.optional(),
  })
  .openapi('TiersConfig');

/** PATCH /api/config/tiers body — each tier optional; `null` unsets that tier. */
export const updateTiersBodySchema = z
  .object({
    tiers: z.object({
      small: tierEntrySchema.nullable().optional(),
      medium: tierEntrySchema.nullable().optional(),
      large: tierEntrySchema.nullable().optional(),
    }),
  })
  .openapi('UpdateTiersBody');

/**
 * A fill threshold, as a whole percentage of the answering model's context
 * window.
 *
 * 1–99 rather than 0–100 because neither end means what it looks like: 0 hands
 * off on the first turn and 100 can never fire. `resolveChatsConfig` already
 * falls back to the default for both, so accepting them here would store a
 * number the engine then ignores — the dead-setting failure, written by the
 * editor that exists to show what is live.
 */
const thresholdPercentSchema = z.number().int().min(1).max(99);

/** Same reasoning: past the watch's own 24-hour expiry the alarm cannot show. */
const ciWaitAlarmMinutesSchema = z.number().int().min(1).max(MAX_CI_WAIT_ALARM_MINUTES);

/** The effective chat thresholds — resolved, so every field is present. */
export const chatsConfigSchema = z
  .object({
    nudgeAtPercent: thresholdPercentSchema,
    handoffAtPercent: thresholdPercentSchema,
    autoHandoff: z.boolean(),
    ciWaitAlarmMinutes: ciWaitAlarmMinutesSchema,
    suggestNextMessage: z.boolean(),
  })
  .openapi('ChatsConfig');

/**
 * PATCH /api/config/chats body — each field optional, absent keys preserved.
 *
 * The cross-field rule is checked here rather than left to the resolver: a
 * nudge at or above the handoff point would announce a suggestion the system
 * had already acted on, and the resolver's response is to silently substitute
 * the default. Silent substitution is right for a config file written by hand
 * and wrong for a form that just told someone their change was saved.
 */
export const updateChatsBodySchema = z
  .object({
    nudgeAtPercent: thresholdPercentSchema.optional(),
    handoffAtPercent: thresholdPercentSchema.optional(),
    autoHandoff: z.boolean().optional(),
    ciWaitAlarmMinutes: ciWaitAlarmMinutesSchema.optional(),
    suggestNextMessage: z.boolean().optional(),
  })
  .openapi('UpdateChatsBody');

export const safeConfigSchema = z
  .object({
    botName: z.string(),
    assistant: z.string().min(1),
    assistants: z.record(z.string(), providerDefaultsSchema),
    streaming: z.object({
      telegram: z.enum(['stream', 'batch']),
      discord: z.enum(['stream', 'batch']),
      slack: z.enum(['stream', 'batch']),
      // github removed — never implemented; hardcoded 'batch' in GitHubAdapter
    }),
    concurrency: z.object({ maxConversations: z.number() }),
    defaults: z.object({
      loadDefaultCommands: z.boolean(),
      loadDefaultWorkflows: z.boolean(),
    }),
    // Configured small/medium/large tiers (merged repo > global). Absent keys
    // fall back to `tierDefaults` (built-in presets for the default provider).
    tiers: tiersConfigSchema.optional(),
    tierDefaults: tiersConfigSchema.optional(),
    // Configured @custom model aliases (merged repo > global). Not secrets.
    aliases: z.record(z.string(), tierEntrySchema).optional(),
    // Resolved, so always present — see SafeConfig.chats in config-types.ts.
    chats: chatsConfigSchema,
  })
  .openapi('SafeConfig');

/** PATCH /api/config/aliases body — per-key merge; `null` unsets that alias. */
export const updateAliasesBodySchema = z
  .object({
    aliases: z.record(z.string(), tierEntrySchema.nullable()),
  })
  .openapi('UpdateAliasesBody');

/** Body for PATCH /api/config/assistants — all fields optional (partial update). */
export const updateAssistantConfigBodySchema = z
  .object({
    assistant: z.string().min(1).optional(),
    assistants: z.record(z.string(), providerDefaultsSchema).optional(),
  })
  .openapi('UpdateAssistantConfigBody');

/** Response for GET /api/config and PATCH /api/config/assistants — returns updated safe config. */
export const configResponseSchema = z
  .object({
    config: safeConfigSchema,
    database: z.string(),
  })
  .openapi('ConfigResponse');

/** @deprecated Use configResponseSchema instead. */
export const updateAssistantConfigResponseSchema = configResponseSchema;

/** A single isolation environment record. */
export const isolationEnvironmentSchema = z
  .object({
    id: z.string(),
    codebase_id: z.string(),
    branch_name: z.string(),
    working_path: z.string(),
    status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    days_since_activity: z.number(),
  })
  .openapi('IsolationEnvironment');

/** Response for GET /api/codebases/:id/environments. */
export const codebaseEnvironmentsResponseSchema = z
  .object({
    environments: z.array(isolationEnvironmentSchema),
  })
  .openapi('CodebaseEnvironmentsResponse');
