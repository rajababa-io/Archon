/**
 * Zod schemas for conversation and message API endpoints.
 */
import { z } from '@hono/zod-openapi';
import { conversationColorSchema, conversationRowSchema } from '@archon/core/schemas/conversation';
import { messageRowSchema } from '@archon/core/schemas/message';
import { EFFORT_LADDER } from '@archon/paths/effort';

/** A conversation record (wire shape with ISO string dates). */
export const conversationSchema = conversationRowSchema
  .extend({
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    deleted_at: z.string().datetime().nullable(),
    completed_at: z.string().datetime().nullable(),
    last_read_at: z.string().datetime().nullable(),
    ready_at: z.string().datetime().nullable(),
    last_activity_at: z.string().datetime().nullable(),
  })
  .openapi('Conversation');

/** GET /api/conversations query params. */
export const listConversationsQuerySchema = z.object({
  // How many rows to return. A caller that only wants the counts — the project
  // rail draws a number, not a list — asks for few rows and reads `counts`,
  // rather than paying for a page it will throw away. Omitted takes the
  // route's own default.
  limit: z.coerce.number().int().positive().optional(),
  platform: z.string().optional(),
  codebaseId: z.string().optional(),
  // Non-enforcing "mine" filter: 'true' restricts to the caller's own
  // conversations when an identity resolves. Default lists everything. Enum
  // makes the boolean contract explicit (the handler treats only 'true' as on).
  mine: z.enum(['true', 'false']).optional(),
  // Which archived state to list. Omitted behaves exactly as before, so every
  // existing caller keeps seeing active conversations only.
  archived: z.enum(['active', 'archived', 'all']).optional(),
  // Where in its lifecycle a chat is: `open` has no completion recorded,
  // `done` has one. Omitted does not ask, so an existing caller keeps every
  // row it already got. Separate from `archived` because it is a separate
  // question on a separate column — removed versus finished.
  state: z.enum(['open', 'done', 'all']).optional(),
});

/**
 * GET /api/conversations response.
 *
 * An envelope rather than a bare array because the listing is capped: the
 * counts alongside answer for every row the filters match, so a client can
 * tell a complete list from a truncated one. Finished chats accumulate without
 * bound, which makes silent truncation a question of when rather than whether.
 */
export const conversationListResponseSchema = z
  .object({
    conversations: z.array(
      conversationSchema.extend({
        // Listed rows carry the newest assistant message when it might hold an
        // ask block, so the rail can badge a chat that is waiting on an answer.
        // Only this route computes it; fetching one conversation does not.
        ask_candidate: z.string().nullable(),
      })
    ),
    /**
     * How many chats each lifecycle scope holds under the same filters, with
     * `state` ignored. `counts[state]` is the total for what was asked, so a
     * client can tell a complete list from a truncated one; the other two let
     * a rail label a scope it is not currently showing.
     */
    counts: z.object({
      open: z.number().int(),
      done: z.number().int(),
      all: z.number().int(),
    }),
  })
  .openapi('ConversationListResponse');

/** Path params for routes with :id (platform conversation ID). */
export const conversationIdParamsSchema = z.object({ id: z.string() });

/**
 * GET /api/conversations/:id/lock response.
 *
 * Whether the server is executing a turn for this conversation right now. It
 * is the same fact the `conversation_lock` SSE event announces, asked for
 * rather than waited for: a client that lost the stream missed whichever
 * announcements were made in the gap, and nothing replays them.
 */
export const conversationLockResponseSchema = z
  .object({
    conversationId: z.string(),
    locked: z.boolean(),
  })
  .openapi('ConversationLockResponse');

/**
 * GET /api/conversations/:id/checkout response — where the chat's agent edits.
 *
 * Every field is nullable and null means "not known", never a default: the
 * console hides an unknown value rather than showing a clean tree or the live
 * checkout it cannot vouch for.
 */
export const conversationCheckoutResponseSchema = z
  .object({
    path: z.string().nullable(),
    location: z.enum(['live', 'worktree']).nullable(),
    branch: z.string().nullable(),
    dirty: z.boolean().nullable(),
  })
  .openapi('ConversationCheckoutResponse');

/**
 * POST /api/conversations/:id/interrupt response.
 *
 * `stopped` — the running turn received the abort and has ended; the lock is
 * released. `stopping` — the abort was delivered but the turn has not ended
 * yet; the provider owns how quickly it honours it, and the lock stays held
 * until it does. `idle` — no turn was running, so there was nothing to stop.
 */
export const conversationInterruptResponseSchema = z
  .object({
    conversationId: z.string(),
    status: z.enum(['stopped', 'stopping', 'idle']),
  })
  .openapi('ConversationInterruptResponse');

/** A message waiting behind the running turn, as its sender sees it. */
export const queuedMessageSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    files: z.array(z.object({ name: z.string(), mimeType: z.string(), size: z.number() })),
    queuedAt: z.string(),
  })
  .openapi('QueuedMessage');

/**
 * GET /api/conversations/:id/queue response — the messages accepted for this
 * chat and not yet delivered, oldest first. Held in the server's memory, so a
 * reload or a second tab reads the same list.
 */
export const conversationQueueResponseSchema = z
  .object({
    conversationId: z.string(),
    messages: z.array(queuedMessageSchema),
  })
  .openapi('ConversationQueueResponse');

/** Path params for DELETE /api/conversations/:id/queue/:queuedId. */
export const queuedMessageParamsSchema = z.object({ id: z.string(), queuedId: z.string() });

/**
 * DELETE /api/conversations/:id/queue/:queuedId response.
 *
 * One of two outcomes, decided on the server: the message was still waiting and
 * is now withdrawn (its text comes back, so an edit starts from what was
 * actually queued), or it is no longer queued — delivered already, or never
 * queued — and nothing changed.
 */
export const withdrawQueuedResponseSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('withdrawn'), message: queuedMessageSchema }),
    z.object({ status: z.literal('not-queued') }),
  ])
  .openapi('WithdrawQueuedResponse');

/** POST /api/conversations request body. Uses strict() to reject unknown fields (e.g. conversationId). */
export const createConversationBodySchema = z
  .object({
    codebaseId: z.string().optional(),
    message: z.string().optional(),
  })
  .strict()
  .openapi('CreateConversationBody');

/** POST /api/conversations response. */
export const createConversationResponseSchema = z
  .object({
    conversationId: z.string(),
    id: z.string(),
    dispatched: z.boolean().optional(),
  })
  .openapi('CreateConversationResponse');

/**
 * PATCH /api/conversations/:id request body.
 *
 * `color: null` clears the color — distinct from omitting the field, which
 * leaves it untouched. Without that distinction a color could be set but never
 * removed.
 *
 * `archived` and `completed` are separate fields because they are separate
 * questions: done says the chat's unit of work landed, archived says stop
 * listing it. Either can be true without the other.
 *
 * `ready` is a third, and it is the agent's field rather than a human's: it says
 * the agent believes the work is finished and is waiting to be told. It is kept
 * out of `completed` so that an agent can never close its own work — and so a
 * reader can always tell which of the two parties spoke.
 */
export const updateConversationBodySchema = z
  .object({
    title: z.string().min(1).optional(),
    color: conversationColorSchema.nullable().optional(),
    // true archives, false restores. Omitted leaves the state alone, so a
    // rename cannot accidentally resurrect an archived chat.
    archived: z.boolean().optional(),
    // true marks the chat's unit of work finished, false reopens it. Omitted
    // leaves it alone — the same rule as `archived`, and for the same reason:
    // a rename must not decide whether the work is done.
    completed: z.boolean().optional(),
    // true records the AGENT's claim that the work is finished, false withdraws
    // it. Separate from `completed` because they are assertions by different
    // parties: this one asks for a judgement, that one is the judgement. Setting
    // `completed: true` also clears this, since the claim has been answered.
    ready: z.boolean().optional(),
  })
  .openapi('UpdateConversationBody');

/**
 * PUT /api/conversations/order request body.
 *
 * `ids` is a RUN of chats as the rail is showing them, top first — not the
 * whole project. The rail displays one archive scope at a time, so it can only
 * speak for what it can see; the server rearranges those chats within the
 * positions they already hold and leaves every other chat alone.
 *
 * Capped at 200 because the list route returns at most 50: a longer body is a
 * client bug or an attempt to make one request rewrite a whole table.
 */
export const setConversationOrderBodySchema = z
  .object({
    ids: z.array(z.string()).min(1).max(200),
  })
  .strict()
  .openapi('SetConversationOrderBody');

/** Generic success response. */
export const successResponseSchema = z.object({ success: z.boolean() }).openapi('SuccessResponse');

/** A single message row (wire shape). */
export const messageSchema = messageRowSchema
  .extend({
    created_at: z.string().datetime(),
  })
  .openapi('Message');

/** GET /api/conversations/:id/messages query params. */
export const listMessagesQuerySchema = z.object({
  limit: z.string().optional(),
});

/** GET /api/conversations/:id/messages response. */
export const messageListResponseSchema = z.array(messageSchema).openapi('MessageListResponse');

/** POST /api/conversations/:id/message JSON request body. */
export const sendMessageBodySchema = z
  .object({ message: z.string().min(1) })
  .openapi('SendMessageBody');

/** POST /api/conversations/:id/message multipart request body (file uploads). */
export const sendMessageMultipartSchema = z
  .object({
    message: z.string().min(1),
    files: z
      .array(z.string().openapi({ format: 'binary' }))
      .max(5)
      .optional()
      .openapi({ description: 'Maximum 5 files; each file must be ≤ 10 MB' }),
  })
  .openapi('SendMessageMultipartBody');

/** Response for dispatch endpoints (send message, run workflow). */
export const dispatchResponseSchema = z
  .object({
    accepted: z.boolean(),
    status: z.string(),
    /** Present when the message was queued behind a running turn. */
    queuedId: z.string().optional(),
  })
  .openapi('DispatchResponse');

/** One uncommitted change in a chat's checkout. */
export const changedFileSchema = z
  .object({
    path: z.string(),
    oldPath: z.string().nullable(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked', 'other']),
    // null for a binary or oversized file, whose lines git does not count.
    additions: z.number().int().nullable(),
    deletions: z.number().int().nullable(),
  })
  .openapi('ChangedFile');

/**
 * GET /api/conversations/:id/changes response.
 *
 * The uncommitted changes in the directory this chat's agent runs in — the
 * working tree and index against HEAD, plus untracked files. Three states,
 * because "no changes" and "nothing to look at" are different answers:
 *
 * `unscoped` — the chat has no project, so its agent has no one checkout.
 * `not-a-checkout` — the chat's directory is missing or is not a git repository.
 * `ok` — the listing; `omitted` counts changed files past the listing's cap.
 */
export const conversationChangesResponseSchema = z
  .discriminatedUnion('state', [
    z.object({ state: z.literal('unscoped') }),
    z.object({ state: z.literal('not-a-checkout'), path: z.string() }),
    z.object({
      state: z.literal('ok'),
      root: z.string(),
      branch: z.string().nullable(),
      head: z.string().nullable(),
      files: z.array(changedFileSchema),
      omitted: z.number().int(),
    }),
  ])
  .openapi('ConversationChangesResponse');

/** GET /api/conversations/:id/changes/diff query. */
export const conversationChangeDiffQuerySchema = z.object({ path: z.string().min(1) });

/**
 * GET /api/conversations/:id/changes/diff response — one changed file's diff.
 * `truncated` means `patch` is not the whole diff; a binary file has no patch.
 */
export const conversationChangeDiffResponseSchema = z
  .object({
    path: z.string(),
    patch: z.string(),
    binary: z.boolean(),
    truncated: z.boolean(),
  })
  .openapi('ConversationChangeDiffResponse');

/**
 * What the next turn of a chat runs on (#132) — GET and PUT
 * /api/conversations/:id/model both answer with it.
 *
 * `model` null means the provider's own default (no model is passed). `pin` is
 * the chat's own choice when it is in force; null when the chat follows the
 * defaults, including when a stored pin names a provider the chat no longer
 * runs on (the turn ignores such a pin, so this does too).
 */
export const chatModelResponseSchema = z
  .object({
    provider: z.string(),
    model: z.string().nullable(),
    effort: z.enum(EFFORT_LADDER).nullable(),
    pin: z
      .object({ model: z.string().nullable(), effort: z.enum(EFFORT_LADDER).nullable() })
      .nullable(),
  })
  .openapi('ChatModel');

/**
 * PUT /api/conversations/:id/model body — pin this chat's model and effort.
 *
 * `provider` is the one the picker was showing; the server checks both values
 * against that provider in the registry and refuses a mismatch rather than
 * storing a pin no turn would honour. Null for either half means "the default"
 * for that half; both null clears the pin. Applies from the next turn.
 */
export const setChatModelBodySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().trim().min(1).max(255).nullable(),
    effort: z.enum(EFFORT_LADDER).nullable(),
  })
  .openapi('SetChatModelBody');
