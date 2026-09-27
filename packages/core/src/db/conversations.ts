/**
 * Database operations for conversations
 */
import { pool, getDialect } from './connection';
import { looksLikeRowId } from './codebases';
import type { Conversation } from '../types';
import { ConversationNotFoundError } from '../types';
import { createLogger } from '@archon/paths';
import { loadConfig } from '../config/config-loader';
import { cancelCiWatchesForConversation } from './ci-watches';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.conversations');
  return cachedLog;
}

/**
 * Get a conversation by its database ID
 */
export async function getConversationById(id: string): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Find a conversation by platform_conversation_id only (no platform_type filter).
 * Safe because all platform IDs are globally unique (they include platform prefix + timestamp + random).
 * Used by the Web UI API to load conversations from any platform.
 */
export async function findConversationByPlatformId(
  platformId: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_conversation_id = $1',
    [platformId]
  );
  return result.rows[0] ?? null;
}

/**
 * Get a conversation by platform type and platform ID
 * Returns null if not found (unlike getOrCreate which creates)
 */
export async function getConversationByPlatformId(
  platformType: string,
  platformId: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
    [platformType, platformId]
  );
  return result.rows[0] ?? null;
}

export async function getOrCreateConversation(
  platformType: string,
  platformId: string,
  codebaseId?: string,
  parentConversationId?: string,
  userId?: string
): Promise<Conversation> {
  const existing = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
    [platformType, platformId]
  );

  if (existing.rows[0]) {
    // First-user-wins: do not overwrite user_id on subsequent messages in the
    // same thread from a different user. Per-message attribution lives on
    // workflow_runs/messages instead.
    return existing.rows[0];
  }

  // Check if we should inherit from a parent conversation (e.g., Discord thread inheriting from parent channel)
  let inheritedCodebaseId: string | null = null;
  let inheritedCwd: string | null = null;
  let assistantType: string | undefined;

  if (parentConversationId) {
    const parent = await pool.query<Conversation>(
      'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
      [platformType, parentConversationId]
    );
    if (parent.rows[0]) {
      inheritedCodebaseId = parent.rows[0].codebase_id;
      inheritedCwd = parent.rows[0].cwd;
      assistantType = parent.rows[0].ai_assistant_type;
      getLog().debug(
        { inheritedCodebaseId, inheritedCwd },
        'db.conversation_parent_context_inherited'
      );
    }
  }

  // Use provided codebase or inherited codebase
  const finalCodebaseId = codebaseId ?? inheritedCodebaseId;

  // Determine assistant type from codebase if provided (overrides inherited)
  if (codebaseId) {
    const codebase = await pool.query<{ ai_assistant_type: string }>(
      'SELECT ai_assistant_type FROM remote_agent_codebases WHERE id = $1',
      [codebaseId]
    );
    if (codebase.rows[0]) {
      assistantType = codebase.rows[0].ai_assistant_type;
    }
  }

  // No parent or codebase signal: resolve the configured default assistant
  // instead of hard-defaulting to Claude (#2241). loadConfig() owns the
  // fallback chain — explicit config (repo assistant > global defaultAssistant)
  // > DEFAULT_AI_ASSISTANT env > first registered built-in provider. The
  // per-user default assistant (#1998) deliberately stays OUT of this row: the
  // orchestrator applies it per turn (userAiPrefs.defaultProvider ??
  // conversation.ai_assistant_type), sender-first (#1982), so a personal
  // preference is never baked into a shared conversation.
  if (assistantType === undefined) {
    try {
      const config = await loadConfig();
      assistantType = config.assistant;
    } catch (err) {
      // Intentional fallback: a broken config (e.g. an unregistered
      // DEFAULT_AI_ASSISTANT value makes loadConfig throw) must not block
      // conversation creation — the turn itself surfaces config errors.
      getLog().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'db.conversation_default_assistant_config_load_failed'
      );
    }
  }
  assistantType ??= 'claude';

  const created = await pool.query<Conversation>(
    'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [platformType, platformId, assistantType, finalCodebaseId, inheritedCwd, userId ?? null]
  );

  return created.rows[0];
}

export async function updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd' | 'isolation_env_id'>> & {
    hidden?: boolean;
  }
): Promise<void> {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  let i = 1;

  if (updates.codebase_id !== undefined) {
    fields.push(`codebase_id = $${String(i++)}`);
    values.push(updates.codebase_id);
  }
  if (updates.cwd !== undefined) {
    fields.push(`cwd = $${String(i++)}`);
    values.push(updates.cwd);
  }
  if (updates.isolation_env_id !== undefined) {
    fields.push(`isolation_env_id = $${String(i++)}`);
    values.push(updates.isolation_env_id);
  }
  if (updates.hidden !== undefined) {
    fields.push(`hidden = $${String(i++)}`);
    values.push(updates.hidden ? 1 : 0);
  }

  if (fields.length === 0) {
    return; // No updates
  }

  const dialect = getDialect();
  fields.push(`updated_at = ${dialect.now()}`);
  values.push(id);

  const result = await pool.query(
    `UPDATE remote_agent_conversations SET ${fields.join(', ')} WHERE id = $${String(i)}`,
    values
  );

  if (result.rowCount === 0) {
    getLog().error({ conversationId: id, fields, updates }, 'db.conversation_update_not_found');
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Find a conversation by isolation environment ID (legacy - single result)
 * Used for provider-based lookup and shared environment detection
 */
export async function getConversationByIsolationEnvId(envId: string): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1 LIMIT 1',
    [envId]
  );
  return result.rows[0] ?? null;
}

/**
 * Find all conversations using a specific isolation environment (new UUID model)
 */
export async function getConversationsByIsolationEnvId(
  envId: string
): Promise<readonly Conversation[]> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1',
    [envId]
  );
  return result.rows;
}

/** Which soft-delete state a listing asks for. */
export type ConversationArchivedFilter = 'active' | 'archived' | 'all';

/** Where in its lifecycle a listing asks for chats to be. */
export type ConversationStateFilter = 'open' | 'done' | 'all';

/**
 * What a caller may narrow a conversation listing by. An options object rather
 * than a positional list: every field is optional and independent, and seven
 * positional arguments could not be read at a call site without counting
 * `undefined`s.
 */
export interface ListConversationsOptions {
  /** Most rows to return. The listing reports counts separately, so a caller
   *  that hits this limit can tell that it did. */
  limit?: number;
  platformType?: string;
  codebaseId?: string;
  excludeEmpty?: boolean;
  /**
   * Non-enforcing "mine" filter: when set, restrict to conversations attributed
   * to this user (`user_id = $N`). Absent → all (default visibility stays open).
   */
  userId?: string;
  /**
   * Which soft-delete state to return. `active` (the default) preserves the
   * historic behaviour exactly; `archived` returns only soft-deleted rows;
   * `all` returns both.
   */
  archived?: ConversationArchivedFilter;
  /**
   * Where the chat is in its lifecycle: `open` has no completion recorded,
   * `done` has one, `all` (the default) does not ask.
   *
   * A separate question from `archived`, and a separate column. `deleted_at`
   * says whether a row was removed; `completed_at` says whether the work it
   * holds landed. The console asks only this one — it lists open work by
   * default and finished work on request — but the parameter defaults to `all`
   * so every existing caller keeps the rows it already got.
   */
  state?: ConversationStateFilter;
}

/**
 * How many conversations each lifecycle scope holds, under every filter the
 * caller gave EXCEPT `state` — asking for open chats still reports how many
 * are done, which is what lets a rail label a scope it is not showing.
 *
 * Counted rather than derived from the returned rows. The listing is capped,
 * and finished chats accumulate without bound, so `rows.length` answers "how
 * many did I get" and never "how many are there".
 */
export interface ConversationCounts {
  readonly open: number;
  readonly done: number;
  readonly all: number;
}

/** One page of conversations, and the counts the page was drawn from. */
export interface ConversationPage {
  readonly rows: readonly Conversation[];
  readonly counts: ConversationCounts;
}

const NO_CONVERSATIONS: ConversationPage = {
  rows: [],
  counts: { open: 0, done: 0, all: 0 },
};

/**
 * List conversations ordered by recent activity, with per-scope counts.
 */
export async function listConversations(
  options: ListConversationsOptions = {}
): Promise<ConversationPage> {
  const {
    limit = 50,
    platformType,
    codebaseId,
    excludeEmpty = false,
    userId,
    archived = 'active',
    state = 'all',
  } = options;
  const params: unknown[] = [];
  const archivedClause =
    archived === 'active'
      ? 'deleted_at IS NULL'
      : archived === 'archived'
        ? 'deleted_at IS NOT NULL'
        : '1 = 1';
  // Everything except the lifecycle filter. The counts answer for all three
  // scopes at once, so `state` narrows the page and nothing else — a count
  // that inherited it would report done = 0 whenever you asked for open.
  let where = `WHERE ${archivedClause} AND (hidden IS NULL OR hidden = false)`;

  if (excludeEmpty) {
    where +=
      ' AND (title IS NOT NULL OR EXISTS (SELECT 1 FROM remote_agent_messages WHERE conversation_id = remote_agent_conversations.id LIMIT 1))';
  }

  if (platformType) {
    params.push(platformType);
    where += ` AND platform_type = $${String(params.length)}`;
  }

  if (codebaseId) {
    // A filter value that cannot be a row id matches nothing, and saying so is
    // the whole answer. Comparing it to a uuid column raises a driver error
    // instead, which the route above turns into a 500 — the console showed
    // five of those at once when a URL carried a project name where an id
    // belonged. See `looksLikeRowId`.
    if (!looksLikeRowId(codebaseId)) return NO_CONVERSATIONS;
    params.push(codebaseId);
    where += ` AND codebase_id = $${String(params.length)}`;
  }

  if (userId) {
    params.push(userId);
    where += ` AND user_id = $${String(params.length)}`;
  }

  const stateClause =
    state === 'open'
      ? ' AND completed_at IS NULL'
      : state === 'done'
        ? ' AND completed_at IS NOT NULL'
        : '';

  const pageParams = [...params, limit];
  const page = await pool.query<Conversation>(
    `SELECT * FROM remote_agent_conversations ${where}${stateClause} ORDER BY last_activity_at DESC NULLS LAST LIMIT $${String(pageParams.length)}`,
    pageParams
  );
  // SUM(CASE ...) rather than COUNT(*) FILTER: the filtered-aggregate syntax is
  // recent in SQLite and this has to mean the same thing on both adapters.
  const counted = await pool.query<{
    open_count: string | number | null;
    done_count: string | number | null;
    total_count: string | number | null;
  }>(
    `SELECT
       SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS open_count,
       SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS done_count,
       COUNT(*) AS total_count
     FROM remote_agent_conversations ${where}`,
    params
  );
  const row = counted.rows[0];
  return {
    rows: page.rows,
    counts: {
      // SUM over no rows is NULL, not 0.
      open: Number(row?.open_count ?? 0),
      done: Number(row?.done_count ?? 0),
      all: Number(row?.total_count ?? 0),
    },
  };
}

/**
 * Update last_activity_at for staleness tracking
 */
export async function touchConversation(id: string): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_conversations SET last_activity_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
}

/**
 * Who is writing a conversation title, which decides what the pin means to it.
 *
 * - `person` — a human rename. Writes and pins.
 * - `automation` — a generated title (first title, placeholder, drift re-title).
 *   Writes only while the row is unpinned, and leaves the pin as it is.
 * - `request` — an explicit re-title a person asked for (`/retitle`). Overrides
 *   the pin without clearing it: the chat was still named on a person's say-so.
 */
export type ConversationTitleWriter = 'person' | 'automation' | 'request';

/**
 * Update conversation title. Returns whether the title was written.
 *
 * `title_pinned` records WHO chose the name, and is the whole reason automatic
 * titling is safe: the AI generator and a human rename write this same column,
 * so without it nothing downstream can tell a generated title from one someone
 * typed, and automation would silently undo the rename.
 *
 * For `automation` the pin check is part of the UPDATE itself, not a read made
 * beforehand. Title generation waits seconds on a model call, and a rename that
 * lands during that wait has to win — a check made before the call cannot see
 * it, and the write would overwrite the rename while the row still says pinned.
 * `false` means the row is pinned and nothing was written.
 *
 * The pin is never cleared here — a chat a person has named stays named until
 * they say otherwise.
 */
export async function updateConversationTitle(
  id: string,
  title: string,
  writer: ConversationTitleWriter
): Promise<boolean> {
  const dialect = getDialect();
  const pin = writer === 'person' ? ', title_pinned = TRUE' : '';
  // NULL means not pinned (migration 029), so `IS NOT TRUE`, never `= FALSE`.
  const guard = writer === 'automation' ? ' AND title_pinned IS NOT TRUE' : '';
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET title = $1${pin}, updated_at = ${dialect.now()} WHERE id = $2${guard}`,
    [title, id]
  );
  if (result.rowCount > 0) return true;
  // Zero rows under the guard is either "pinned" or "no such chat"; only the
  // second is an error.
  if (writer === 'automation' && (await getConversationById(id))) return false;
  throw new ConversationNotFoundError(id);
}

/**
 * Archive or restore a conversation.
 *
 * Archiving is the same soft delete `softDeleteConversation` performs; this
 * exists so the two directions are one symmetric call, because an archive the
 * user cannot undo is a delete wearing a friendlier word.
 */
export async function setConversationArchived(id: string, archived: boolean): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET deleted_at = ${archived ? dialect.now() : 'NULL'}, updated_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Mark a conversation's unit of work finished, or reopen it.
 *
 * Symmetric for the same reason archiving is: a state a person can enter and
 * not leave is a trap, and work that turns out not to have landed has to be
 * able to say so.
 *
 * The timestamp is the state — there is no separate boolean to disagree with
 * it — and re-marking an already-finished chat moves it to now rather than
 * being rejected, because the caller is asserting the state, not a transition.
 */
export async function setConversationCompleted(id: string, completed: boolean): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET completed_at = ${completed ? dialect.now() : 'NULL'}, updated_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
  // Here rather than in each caller: a human closing the chat, a handoff, and
  // an undone handoff all close through this function, and a closed chat must
  // not be woken by CI it has stopped caring about. Reopening does not revive
  // them — a watch is a request made in a turn, not a property of the chat.
  if (completed) await cancelCiWatchesForConversation(id);
}

/**
 * Record, or withdraw, the agent's claim that this chat's work is finished.
 *
 * Deliberately NOT a completion: `setConversationCompleted` above is the human's
 * judgement and this is the agent asking for one. An agent that could write that
 * column would be closing its own work, and nothing downstream could tell the
 * two apart afterwards.
 *
 * Symmetric like its siblings, and here that is load-bearing rather than a
 * courtesy. The derived version of this signal — "the newest message is the
 * agent's" — was built and removed twice because it could only ever turn ON, so
 * the mark was always lit and `idle` became unreachable (see the console's
 * `chat-status.ts`). Every caller that can turn this off is what makes it safe
 * to turn on: the PATCH route when a human marks the chat done, and
 * `handleMessage` when a human says something more.
 *
 * `updated_at` IS bumped, unlike `markConversationRead` below. Reading a chat
 * observes it; claiming its work is finished changes what the row asserts.
 *
 * Re-asserting an existing claim moves the timestamp to now rather than being
 * rejected, matching `setConversationCompleted`: the caller is stating the
 * state, not a transition.
 */
export async function setConversationReady(id: string, ready: boolean): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET ready_at = ${ready ? dialect.now() : 'NULL'}, updated_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}

/** A chat's own model/effort choice. `model`/`effort` null = that half follows the default. */
export interface ConversationModelPin {
  provider: string;
  model: string | null;
  effort: string | null;
}

/**
 * Pin, or clear, the model and effort this one chat runs on (#132).
 *
 * `null` clears the whole pin. A pin with both halves null is stored as a
 * clear too: a provider with nothing pinned on it asserts nothing, and keeping
 * it would leave a row that reads as pinned while changing no turn.
 *
 * Validation is the caller's: this stores what it is given. The API route
 * checks the values against the provider registry before calling this.
 *
 * Takes effect on the next turn. A turn already running resolved its model
 * before this write and keeps it — the orchestrator reads the row once, at the
 * start of each turn.
 */
export async function setConversationModelPin(
  id: string,
  pin: ConversationModelPin | null
): Promise<void> {
  const dialect = getDialect();
  const effective = pin !== null && (pin.model !== null || pin.effort !== null) ? pin : null;
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET pinned_provider = $2, pinned_model = $3, pinned_effort = $4, updated_at = ${dialect.now()} WHERE id = $1`,
    [id, effective?.provider ?? null, effective?.model ?? null, effective?.effort ?? null]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Record that a human has read this chat to the end.
 *
 * The rail reads unread as `last_activity_at > last_read_at`, so this is the
 * only thing that turns the mark off. It is what makes the mark safe to turn
 * on at all: "the newest message is the agent's" was tried twice without a read
 * marker and failed both times, because every finished chat ends with the agent
 * (see the console's `chat-status.ts`).
 *
 * `updated_at` is deliberately NOT bumped. Every other writer in this file uses
 * it to say the row's CONTENT changed, and reading a chat changes nothing about
 * it — a reader that bumped it would make "when was this last edited"
 * unanswerable for any chat anyone had opened.
 *
 * Unknown ids throw, like every sibling: the caller asked to mark a specific
 * chat read, and silently marking nothing would leave the rail amber with no
 * way to find out why.
 */
export async function markConversationRead(id: string): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET last_read_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Set or clear a conversation's color label.
 *
 * `null` clears it. The value is validated at the API boundary against
 * CONVERSATION_COLORS; this layer stores whatever it is handed.
 */
export async function updateConversationColor(id: string, color: string | null): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET color = $1, updated_at = ${dialect.now()} WHERE id = $2`,
    [color, id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Resolve platform conversation ids to database ids, in one query.
 *
 * The conversation API addresses chats by platform id throughout, and a rail
 * names fifty of them at once; resolving those one at a time would be fifty
 * round trips to arrange one list. Ids with no row are simply absent from the
 * result — the caller decides what an unknown chat means.
 */
export async function findConversationIdsByPlatformIds(
  platformIds: readonly string[]
): Promise<Map<string, string>> {
  if (platformIds.length === 0) return new Map();
  const placeholders = platformIds.map((_, i) => `$${String(i + 1)}`).join(', ');
  const result = await pool.query<{ id: string; platform_conversation_id: string }>(
    `SELECT id, platform_conversation_id FROM remote_agent_conversations WHERE platform_conversation_id IN (${placeholders})`,
    [...platformIds]
  );
  return new Map(result.rows.map(r => [r.platform_conversation_id, r.id]));
}

/**
 * The ascending values a displayed run of chats should hold, given what they
 * hold now.
 *
 * The rail only ever shows a subset — one archive scope, or a search — so it
 * can only speak for the chats it can see. Reusing exactly the values those
 * chats already hold is what lets it say "these, in this order" without
 * knowing, or disturbing, a single chat that was out of view.
 *
 * A chat with no value yet needs one, and it has to be able to end up above
 * everything already placed, so the range is extended DOWNWARD: `missing` new
 * values immediately below the lowest one in play. Which chat receives which
 * value is decided by position alone — the caller's sequence — so a brand-new
 * chat dragged to the bottom takes the highest value, not a seed.
 */
export function nextOrderSlots(current: readonly (number | null)[]): number[] {
  const taken = current.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const missing = current.length - taken.length;
  // `?? 0` is the empty case: nothing has ever been arranged, so the run simply
  // starts somewhere. Negative values are as valid as any other.
  const base = taken[0] ?? 0;
  const seeds = Array.from({ length: missing }, (_, i) => base - missing + i);
  return [...seeds, ...taken];
}

/**
 * Arrange a run of chats: `ids` is the order they should appear in, top first.
 *
 * Ids that do not exist are skipped rather than consuming a position, so a
 * stale row in a rail that has not refreshed cannot shift everything below it.
 * Rows whose value is already correct are not written at all, which keeps the
 * ordinary drag — where only the chats between the two ends actually move — to
 * a handful of statements instead of one per visible chat.
 */
export async function setConversationOrder(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const dialect = getDialect();
  const placeholders = ids.map((_, i) => `$${String(i + 1)}`).join(', ');
  const existing = await pool.query<{ id: string; sort_order: number | null }>(
    `SELECT id, sort_order FROM remote_agent_conversations WHERE id IN (${placeholders})`,
    [...ids]
  );
  const current = new Map(existing.rows.map(r => [r.id, r.sort_order]));
  const present = ids.filter(id => current.has(id));
  const slots = nextOrderSlots(present.map(id => current.get(id) ?? null));

  for (const [i, id] of present.entries()) {
    const next = slots[i];
    if (next === undefined || next === current.get(id)) continue;
    await pool.query(
      `UPDATE remote_agent_conversations SET sort_order = $1, updated_at = ${dialect.now()} WHERE id = $2`,
      [next, id]
    );
  }
}

/**
 * Soft delete a conversation (sets deleted_at timestamp)
 */
export async function softDeleteConversation(id: string): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET deleted_at = ${dialect.now()}, updated_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}
