/**
 * Database operations for conversation messages (Web UI history and orchestrator prompt enrichment)
 */
import { pool, getDialect, getDatabaseType } from './connection';
import type { MessageRow } from '../schemas/message';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.messages');
  return cachedLog;
}

export type { MessageRow } from '../schemas/message';

/**
 * Add a message to conversation history.
 * metadata should contain toolCalls array and/or error object if applicable.
 * userId is the Archon user UUID; pass undefined for assistant messages or
 * when the originating user is unknown.
 *
 * `system` is a notice the conversation itself produced — why it handed off,
 * not what the agent said. It is never replayed to a model (nothing reads this
 * table to build a prompt; provider sessions carry their own context) and the
 * console already renders it under a `System` label. Use it only for durable
 * facts: transient status belongs on `sendStructuredEvent`, which writes
 * nothing down on purpose.
 */
export async function addMessage(
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  metadata?: Record<string, unknown>,
  userId?: string
): Promise<MessageRow> {
  const dialect = getDialect();
  const result = await pool.query<MessageRow>(
    `INSERT INTO remote_agent_messages (conversation_id, role, content, metadata, user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, ${dialect.now()})
     RETURNING *`,
    [conversationId, role, content, JSON.stringify(metadata ?? {}), userId ?? null]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `Failed to persist message: INSERT returned no rows (conversation: ${conversationId})`
    );
  }
  getLog().debug({ conversationId, role, messageId: row.id }, 'db.message_persist_completed');
  return row;
}

/**
 * List messages for a conversation, oldest first.
 * Fetches the newest `limit` messages so that the most recent history is always
 * returned, then reverses to preserve chronological (oldest-first) order.
 * `id DESC` breaks ties between rows sharing a created_at (SQLite stores
 * 1-second granularity) so the LIMIT window is stable across refetches.
 * conversationId is the database UUID (not platform_conversation_id).
 */
export async function listMessages(
  conversationId: string,
  limit = 200
): Promise<readonly MessageRow[]> {
  const result = await pool.query<MessageRow>(
    `SELECT * FROM remote_agent_messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [conversationId, limit]
  );
  return [...result.rows].reverse();
}

/**
 * The conversation's opening user message, or null when it has none.
 *
 * Exists for handoff lineage: a relayed chat carries where it came from in the
 * metadata of the message that seeded it, and that seed is by construction the
 * first user row — the relay creates the conversation and writes it before the
 * successor has said anything. Asked as its own query rather than read out of
 * `listMessages`, whose window holds the NEWEST 200: a successor that ran all
 * night would have pushed its own origin out of view, and the undo would
 * disappear at exactly the point the night made it worth having.
 */
export async function getFirstUserMessage(conversationId: string): Promise<MessageRow | null> {
  const result = await pool.query<MessageRow>(
    `SELECT * FROM remote_agent_messages
     WHERE conversation_id = $1 AND role = 'user'
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [conversationId]
  );
  return result.rows[0] ?? null;
}

/**
 * The newest user message, or null when the conversation has none. Same ordering
 * as `listMessages`, so "latest" means one thing.
 */
export async function getLastUserMessage(conversationId: string): Promise<MessageRow | null> {
  const result = await pool.query<MessageRow>(
    `SELECT * FROM remote_agent_messages
     WHERE conversation_id = $1 AND role = 'user'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [conversationId]
  );
  return result.rows[0] ?? null;
}

/**
 * Get recent messages with workflowResult metadata for a conversation.
 * Used to inject workflow context into the orchestrator prompt.
 * Non-throwing — returns empty array on error.
 */
export async function getRecentWorkflowResultMessages(
  conversationId: string,
  limit = 3
): Promise<readonly MessageRow[]> {
  const dbType = getDatabaseType();
  const metadataFilter =
    dbType === 'postgresql'
      ? "(metadata->>'workflowResult') IS NOT NULL"
      : "json_extract(metadata, '$.workflowResult') IS NOT NULL";
  try {
    const result = await pool.query<Pick<MessageRow, 'id' | 'content' | 'metadata'>>(
      `SELECT id, content, metadata FROM remote_agent_messages
       WHERE conversation_id = $1
       AND ${metadataFilter}
       -- id DESC tie-breaker: see listMessages() above for why.
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [conversationId, limit]
    );
    return result.rows as MessageRow[];
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, conversationId }, 'db.workflow_result_messages_query_failed');
    return [];
  }
}

/**
 * How many times this chat has already been told to hand itself off.
 *
 * The guard against doing it twice has to survive a restart, because a restart
 * is what broke it: the in-memory band map that stops a threshold announcing
 * repeatedly is cleared on boot, and re-arming an ANNOUNCEMENT costs a repeated
 * sentence while re-arming an ACTION costs a second document and a second
 * successor. Observed on 2026-09-22, when a deploy landed between two readings.
 *
 * Counted from the durable notice the handoff already writes rather than from
 * new state, and matched on a metadata flag rather than on the sentence — the
 * wording is prose and will be reworded, the flag is a contract.
 *
 * Bounded rather than absolute. One retry is what recovered the interrupted
 * attempt above: a handoff that fails leaves the chat open, and the unattended
 * case is exactly where nobody is present to ask for another. Two is the whole
 * budget; past that something is wrong that repeating will not fix.
 */
export async function countAutoHandoffNotices(conversationId: string): Promise<number> {
  const dbType = getDatabaseType();
  const flag =
    dbType === 'postgresql'
      ? "(metadata->>'autoHandoff') = 'true'"
      : "json_extract(metadata, '$.autoHandoff') = 1";
  try {
    const result = await pool.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM remote_agent_messages
       WHERE conversation_id = $1 AND role = 'system' AND ${flag}`,
      [conversationId]
    );
    return Number(result.rows[0]?.count ?? 0);
  } catch (error) {
    // Blocks rather than allows. Not knowing how many times this already fired
    // is not the same as knowing it never did, and the failure this guards is
    // the expensive one.
    getLog().warn({ err: error as Error, conversationId }, 'db.auto_handoff_count_failed');
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * The newest message in each of several conversations, in one query.
 *
 * For deciding whether a chat is waiting on a human: the answer depends only
 * on the LAST message, so fetching histories to look at their tails would be
 * the wrong shape entirely.
 *
 * A window function rather than `DISTINCT ON` — the latter is PostgreSQL-only
 * and this has to run on SQLite too. `created_at DESC, id DESC` matches the
 * ordering `listMessages` uses, so "last" means the same thing in both.
 */
export async function getLastMessagePerConversation(
  conversationIds: readonly string[]
): Promise<Map<string, Pick<MessageRow, 'role' | 'content'>>> {
  const out = new Map<string, Pick<MessageRow, 'role' | 'content'>>();
  if (conversationIds.length === 0) return out;

  const placeholders = conversationIds.map((_, i) => `$${String(i + 1)}`).join(', ');
  try {
    const result = await pool.query<Pick<MessageRow, 'conversation_id' | 'role' | 'content'>>(
      `SELECT conversation_id, role, content FROM (
         SELECT conversation_id, role, content,
                ROW_NUMBER() OVER (
                  PARTITION BY conversation_id
                  ORDER BY created_at DESC, id DESC
                ) AS rn
         FROM remote_agent_messages
         WHERE conversation_id IN (${placeholders})
       ) ranked
       WHERE rn = 1`,
      [...conversationIds]
    );
    for (const row of result.rows) {
      out.set(row.conversation_id, { role: row.role, content: row.content });
    }
  } catch (error) {
    // Non-throwing: this decorates a list that must still render without it.
    getLog().warn({ err: error as Error }, 'db.last_message_per_conversation_failed');
  }
  return out;
}

/**
 * Record what a turn cost onto the assistant message that turn produced.
 *
 * An UPDATE rather than a field on the INSERT, because the two facts arrive in
 * the wrong order: the web adapter streams and persists the reply as it
 * arrives, while the provider only reports usage once the turn is complete.
 * Writing it afterwards is what lets the reading belong to the message it
 * describes instead of to whatever is persisted next.
 *
 * Merges into existing metadata — tool calls are already in there and must
 * survive. Non-throwing: a missing cost reading must never fail a turn that
 * otherwise succeeded.
 */
export async function attachUsageToLatestAssistantMessage(
  conversationId: string,
  usage: Record<string, number | string>
): Promise<void> {
  try {
    const result = await pool.query<Pick<MessageRow, 'id' | 'metadata'>>(
      `SELECT id, metadata FROM remote_agent_messages
       WHERE conversation_id = $1 AND role = 'assistant'
       -- Same ordering as listMessages: "latest" has to mean one thing.
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [conversationId]
    );
    const row = result.rows[0];
    if (!row) return;

    let metadata: Record<string, unknown> = {};
    if (typeof row.metadata === 'string' && row.metadata !== '') {
      try {
        const parsed: unknown = JSON.parse(row.metadata);
        if (parsed !== null && typeof parsed === 'object') {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        // Unparseable metadata is someone else's bug; do not compound it by
        // overwriting whatever is in there.
        return;
      }
    }
    metadata.usage = usage;

    await pool.query('UPDATE remote_agent_messages SET metadata = $1 WHERE id = $2', [
      JSON.stringify(metadata),
      row.id,
    ]);
  } catch (error) {
    getLog().warn({ err: error as Error, conversationId }, 'db.attach_usage_failed');
  }
}
