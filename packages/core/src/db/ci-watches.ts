/**
 * A chat's standing request to hear when CI finishes on one commit.
 *
 * Persisted because the request must outlive the turn that made it: every
 * in-turn timer an agent can start dies with the turn or the container, which
 * is how a chat came to promise "I'll tell you when CI is done" and never did.
 */
import { randomUUID } from 'crypto';
import { pool, getDialect } from './connection';
import { toHydratedTimestamp } from './timestamps';

export interface CiWatch {
  id: string;
  /** Database id of the owning conversation. */
  conversationId: string;
  /** `owner/name`, lower-cased — GitHub treats repository names case-insensitively. */
  repo: string;
  /** Full 40-character commit SHA the checks run against. */
  headSha: string;
  pullRequest: number | null;
  createdAt: Date;
}

interface CiWatchRow {
  id: string;
  conversation_id: string;
  repo: string;
  head_sha: string;
  pull_request: number | null;
  created_at: Date | string;
}

function toCiWatch(row: CiWatchRow): CiWatch {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    repo: row.repo,
    headSha: row.head_sha,
    pullRequest: row.pull_request,
    createdAt: toHydratedTimestamp(row.created_at),
  };
}

const COLUMNS = 'id, conversation_id, repo, head_sha, pull_request, created_at';

/**
 * Open a watch, or return the one this chat already has open on that commit.
 *
 * Asking twice is the same request, so the second ask must not become a second
 * message when CI finishes. The partial unique index decides that race rather
 * than a read-then-write here.
 */
export async function openCiWatch(input: {
  conversationId: string;
  repo: string;
  headSha: string;
  pullRequest: number | null;
}): Promise<{ watch: CiWatch; created: boolean }> {
  const repo = input.repo.toLowerCase();
  const headSha = input.headSha.toLowerCase();
  const inserted = await pool.query<CiWatchRow>(
    `INSERT INTO remote_agent_ci_watches (id, conversation_id, repo, head_sha, pull_request)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [randomUUID(), input.conversationId, repo, headSha, input.pullRequest]
  );
  const row = inserted.rows[0];
  if (row) return { watch: toCiWatch(row), created: true };
  const existing = await pool.query<CiWatchRow>(
    `SELECT ${COLUMNS} FROM remote_agent_ci_watches
     WHERE conversation_id = $1 AND repo = $2 AND head_sha = $3 AND status = 'open'`,
    [input.conversationId, repo, headSha]
  );
  const found = existing.rows[0];
  if (!found) {
    throw new Error(
      `CI watch insert conflicted but no open watch exists for ${repo}@${headSha} (conversation ${input.conversationId})`
    );
  }
  return { watch: toCiWatch(found), created: false };
}

export async function listOpenCiWatchesForHead(repo: string, headSha: string): Promise<CiWatch[]> {
  const result = await pool.query<CiWatchRow>(
    `SELECT ${COLUMNS} FROM remote_agent_ci_watches
     WHERE repo = $1 AND head_sha = $2 AND status = 'open'`,
    [repo.toLowerCase(), headSha.toLowerCase()]
  );
  return result.rows.map(toCiWatch);
}

export async function listOpenCiWatches(): Promise<CiWatch[]> {
  const result = await pool.query<CiWatchRow>(
    `SELECT ${COLUMNS} FROM remote_agent_ci_watches WHERE status = 'open' ORDER BY created_at ASC`
  );
  return result.rows.map(toCiWatch);
}

/**
 * Take the right to fire a watch. True for exactly one caller per watch.
 *
 * A compare-and-set rather than a read: a webhook and the reconcile sweep can
 * both find the same open watch, and only the one whose UPDATE lands may send
 * the chat a message.
 */
export async function claimCiWatch(id: string): Promise<boolean> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_ci_watches SET status = 'fired', settled_at = ${dialect.now()}
     WHERE id = $1 AND status = 'open'`,
    [id]
  );
  return result.rowCount === 1;
}

/**
 * Hand a claimed watch back, because its message was never delivered.
 *
 * Only for a delivery the server refused outright (a drain before a restart):
 * nothing reached the chat, so leaving the watch fired would lose the message
 * rather than deduplicate it. The next reconcile after the restart fires it.
 */
export async function releaseCiWatch(id: string): Promise<void> {
  await pool.query(
    `UPDATE remote_agent_ci_watches SET status = 'open', settled_at = NULL
     WHERE id = $1 AND status = 'fired'`,
    [id]
  );
}

/** Closing a chat ends what it was waiting for. Returns how many watches that cancelled. */
export async function cancelCiWatchesForConversation(conversationId: string): Promise<number> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_ci_watches SET status = 'cancelled', settled_at = ${dialect.now()}
     WHERE conversation_id = $1 AND status = 'open'`,
    [conversationId]
  );
  return result.rowCount;
}

export interface CiWaitingChat {
  /** The id the console rail keys its rows by. */
  platformConversationId: string;
  /**
   * When the chat's OLDEST open watch was opened. The oldest, because a watch
   * still open long after a newer one was added is itself the thing worth
   * noticing — a newer start time would hide it.
   */
  since: Date;
}

/** Chats with an open watch, and how long each has been waiting. */
export async function listCiWaitingChats(): Promise<CiWaitingChat[]> {
  const result = await pool.query<{ platform_conversation_id: string; since: Date | string }>(
    `SELECT c.platform_conversation_id, MIN(w.created_at) AS since
     FROM remote_agent_ci_watches w
     JOIN remote_agent_conversations c ON c.id = w.conversation_id
     WHERE w.status = 'open'
     GROUP BY c.platform_conversation_id`
  );
  return result.rows.map(r => ({
    platformConversationId: r.platform_conversation_id,
    since: toHydratedTimestamp(r.since),
  }));
}
