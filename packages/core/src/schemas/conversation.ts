/**
 * Zod schemas for conversation row types.
 */
import { z } from '@hono/zod-openapi';
import { identityPlatformSchema } from './user';

// Re-export so consumers don't need to import from user.ts directly
export { identityPlatformSchema };
export type { IdentityPlatform } from './user';

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/**
 * The colors a conversation may be labelled with. Names, not hex values, so the
 * UI owns the rendering and a theme change never has to rewrite stored rows.
 *
 * `null` means no color, which is every conversation's default. The server
 * never interprets a color; it is a visual label for scanning a chat list.
 */
export const CONVERSATION_COLORS = ['magenta', 'violet', 'blue', 'green', 'amber', 'red'] as const;

export const conversationColorSchema = z.enum(CONVERSATION_COLORS);
export type ConversationColor = z.infer<typeof conversationColorSchema>;

export const conversationRowSchema = z.object({
  id: z.string(),
  platform_type: z.string(),
  platform_conversation_id: z.string(),
  codebase_id: z.string().nullable(),
  cwd: z.string().nullable(),
  isolation_env_id: z.string().nullable(),
  ai_assistant_type: z.string(),
  title: z.string().nullable(),
  color: z.string().nullable(),
  hidden: z.boolean(),
  /**
   * Hand-arranged position in the chat rail, ascending. NULL means never
   * arranged, and reads as "newest first" — the client puts those above every
   * placed chat, because a brand-new chat at the bottom of a long rail cannot
   * be found.
   *
   * Ties are possible and harmless: the rail only ever renumbers the chats it
   * is showing, so an archived chat can hold the same value as an active one.
   * Whoever reads the column breaks a tie by recency.
   */
  sort_order: z.number().nullable(),
  /**
   * A human named this chat, so automatic re-titling leaves it alone.
   *
   * Nullable because every row predates the column and an older binary never
   * writes it — absent and false are the same statement. Pinned means "a person
   * chose this", not "frozen": an explicit request to re-title still overrides
   * it. The rule is that automation respects the edit and a direct instruction
   * does not have to.
   */
  title_pinned: z.boolean().nullable(),
  /**
   * When a human said this chat's unit of work was finished.
   *
   * A chat is one issue or one cluster of them, and "finished" is a judgement
   * only a person can make — nothing the server can observe distinguishes
   * "the work landed" from "nothing is running at this instant", which is
   * what an absent run already says.
   *
   * Independent of `deleted_at`, because the two answer different questions:
   * done says the work landed, archived says stop showing it. A finished
   * chat you still want in the rail is the normal case.
   */
  completed_at: z.date().nullable(),
  /**
   * When a human last read this chat to the end.
   *
   * Paired with `last_activity_at`, and only meaningful beside it: unread is
   * `last_activity_at > last_read_at`. NULL means never read, which is the
   * answer for a chat nobody has opened and for every row that predates the
   * column — one meaning, not two.
   *
   * It exists because the cheap version of the signal does not work. "The
   * newest message is the agent's" was built and removed twice, since every
   * finished chat ends with the agent, so the whole rail went amber and `idle`
   * became unreachable. A mark that is always on is not a signal. Reading is
   * what turns this one off.
   *
   * Rows that predate the column were backfilled from `last_activity_at` once,
   * in the boot that added it: they were read, there was simply nowhere to
   * record it, and leaving them NULL would have delivered that same all-amber
   * rail on the first boot after the upgrade.
   */
  last_read_at: z.date().nullable(),
  /**
   * When the agent declared this chat's work finished, pending a human saying so.
   *
   * The pair with `completed_at` is the point: that one is the HUMAN's answer to
   * "did the work land", this one is the AGENT's claim awaiting that answer. Two
   * parties, two assertions, two columns. Collapsing them would make the agent
   * able to close its own work, which is the one thing this must not do.
   *
   * NULL means no claim, and it is also the honest answer for every row that
   * predates the column — so, unlike `last_read_at`, there is nothing to
   * backfill. The OFF state and the never-recorded state mean the same thing
   * here, which is what makes a bare ADD COLUMN sufficient.
   *
   * Cleared by two acts: a human marking the chat done (the judgement arrived,
   * so the claim is spent) and the agent withdrawing it when a human's message
   * reopens the work. A message alone does not clear it — most are questions
   * about the finished work (#237). Nothing the server observes on its own clears it —
   * deliberately, because "the agent spoke last" is the derived version of this
   * signal and it failed twice for being unable to turn off. See `last_read_at`
   * above and the console's `chat-status.ts`.
   */
  ready_at: z.date().nullable(),
  /**
   * The model and effort this chat runs on, chosen inside it (#132). The
   * provider travels with the pin because a model id only means something on
   * the provider it was chosen for: a turn that resolves to another provider
   * ignores the pin. `pinned_model` and `pinned_effort` are independent — either
   * may be set without the other. All NULL means the chat follows the defaults.
   */
  pinned_provider: z.string().nullable(),
  pinned_model: z.string().nullable(),
  pinned_effort: z.string().nullable(),
  deleted_at: z.date().nullable(),
  last_activity_at: z.date().nullable(),
  user_id: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type Conversation = z.infer<typeof conversationRowSchema>;
