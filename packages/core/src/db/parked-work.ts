/**
 * Work a deploy parked so it could replace the container (#144).
 *
 * Only the drain park step writes these rows, and a resuming server replays these
 * rows and nothing else — the table IS the provenance that lets a new process
 * resume work without guessing about a `running` row whose owner it cannot see.
 *
 * `resumed_at` is the one-shot marker. It is set by compare-and-swap BEFORE the
 * work is dispatched (see {@link claimParkedRow}), so a crash during replay loses
 * at most the row being claimed and never runs a row twice.
 */
import { z } from '@hono/zod-openapi';
import { createLogger } from '@archon/paths';

import { pool, getDialect, getDatabase } from './connection';
import type { TransactionQuery } from './resource-slots';
import type { AttachedFile } from '../types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.parked-work');
  return cachedLog;
}

export const parkedWorkKindSchema = z.enum(['chat_resume', 'queued_message', 'workflow_run']);
export type ParkedWorkKind = z.infer<typeof parkedWorkKindSchema>;

const attachedFilesSchema = z.array(
  z.object({
    path: z.string(),
    name: z.string(),
    mimeType: z.string(),
    size: z.number(),
  })
);

/**
 * One parked chat item, replayed in `seq` order within its conversation.
 *
 * - `chat_resume` (seq 0): the turn that was interrupted. Replayed as one
 *   system-authored message telling the agent to check what its last step did.
 *   `content` is the last user message the chat had received, for reference.
 * - `queued_message` (seq 1..n): a message that was waiting behind it, replayed
 *   exactly as the user sent it.
 */
export interface ParkedChatItem {
  kind: Exclude<ParkedWorkKind, 'workflow_run'>;
  seq: number;
  content: string;
  attachedFiles: AttachedFile[];
  userId: string | null;
}

export interface ParkedChatRow extends ParkedChatItem {
  id: string;
  drainId: string;
  /** The conversation's database id, not its platform id. */
  conversationId: string;
}

export interface ParkedWorkCounts {
  chats: number;
  queuedMessages: number;
  runs: number;
}

export interface DrainParkSummary {
  parked: ParkedWorkCounts;
  resumed: ParkedWorkCounts;
}

interface ParkedChatDbRow {
  id: string;
  drain_id: string;
  kind: string;
  conversation_id: string;
  seq: number;
  content: string;
  attached_files: unknown;
  user_id: string | null;
}

function readAttachedFiles(raw: unknown, rowId: string): AttachedFile[] {
  if (raw === null || raw === undefined) return [];
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const parsed = attachedFilesSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`parked work ${rowId} has unreadable attached_files`);
  }
  return parsed.data;
}

/** Record every parked item of one conversation, all or nothing. Returns their ids in order. */
export async function insertParkedChat(
  drainId: string,
  conversationId: string,
  items: readonly ParkedChatItem[]
): Promise<string[]> {
  const dialect = getDialect();
  return getDatabase().withTransaction(async query => {
    const ids: string[] = [];
    for (const item of items) {
      const id = dialect.generateUuid();
      ids.push(id);
      await query(
        `INSERT INTO remote_agent_parked_work
           (id, drain_id, kind, conversation_id, seq, content, attached_files, user_id, parked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${dialect.now()})`,
        [
          id,
          drainId,
          item.kind,
          conversationId,
          item.seq,
          item.content,
          item.attachedFiles.length > 0 ? JSON.stringify(item.attachedFiles) : null,
          item.userId,
        ]
      );
    }
    return ids;
  });
}

/** Record a parked run inside the transaction that paused it. */
export async function insertParkedRun(
  query: TransactionQuery,
  drainId: string,
  runId: string
): Promise<void> {
  const dialect = getDialect();
  await query(
    `INSERT INTO remote_agent_parked_work (id, drain_id, kind, run_id, parked_at)
     VALUES ($1, $2, 'workflow_run', $3, ${dialect.now()})`,
    [dialect.generateUuid(), drainId, runId]
  );
}

/** Every chat item not yet claimed, grouped by conversation and in replay order. */
export async function listUnresumedParkedChats(): Promise<ParkedChatRow[]> {
  const result = await pool.query<ParkedChatDbRow>(
    `SELECT id, drain_id, kind, conversation_id, seq, content, attached_files, user_id
       FROM remote_agent_parked_work
      WHERE resumed_at IS NULL AND kind IN ('chat_resume', 'queued_message')
      ORDER BY conversation_id, parked_at, seq`,
    []
  );
  return result.rows.map(row => {
    const kind = parkedWorkKindSchema.parse(row.kind);
    if (kind === 'workflow_run') throw new Error(`parked work ${row.id} is not a chat item`);
    return {
      id: row.id,
      drainId: row.drain_id,
      kind,
      conversationId: row.conversation_id,
      seq: row.seq,
      content: row.content,
      attachedFiles: readAttachedFiles(row.attached_files, row.id),
      userId: row.user_id,
    };
  });
}

/**
 * Take one parked item for replay. True for exactly one caller, ever — the
 * replay dispatches only on true, which is what makes replay at-most-once.
 */
export async function claimParkedRow(id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE remote_agent_parked_work SET resumed_at = ${getDialect().now()}
      WHERE id = $1 AND resumed_at IS NULL`,
    [id]
  );
  return result.rowCount > 0;
}

/**
 * Give back a claim whose dispatch was refused — the server began draining again
 * mid-replay — so the next replay delivers it, still in order.
 */
export async function unclaimParkedRow(id: string): Promise<void> {
  await pool.query('UPDATE remote_agent_parked_work SET resumed_at = NULL WHERE id = $1', [id]);
}

/** Withdraw a row that turned out to describe nothing, before anything claimed it. */
export async function discardParkedRow(id: string): Promise<void> {
  await pool.query('DELETE FROM remote_agent_parked_work WHERE id = $1 AND resumed_at IS NULL', [
    id,
  ]);
}

/** Mark a parked run resumed, inside the transaction that resumed it. */
export async function markParkedRunResumed(query: TransactionQuery, runId: string): Promise<void> {
  const result = await query(
    `UPDATE remote_agent_parked_work SET resumed_at = ${getDialect().now()}
      WHERE run_id = $1 AND resumed_at IS NULL`,
    [runId]
  );
  if (result.rowCount === 0) {
    // The run carried a park wait with no unresumed row behind it. Resuming it is
    // still right — the wait context is what paused it — but the drain report will
    // not count it, so say so.
    getLog().warn({ runId }, 'db.parked_run_resumed_without_marker');
  }
}

function emptyCounts(): ParkedWorkCounts {
  return { chats: 0, queuedMessages: 0, runs: 0 };
}

const countKey: Record<ParkedWorkKind, keyof ParkedWorkCounts> = {
  chat_resume: 'chats',
  queued_message: 'queuedMessages',
  workflow_run: 'runs',
};

/** What one drain parked, and how much of it has been resumed. */
export async function summarizeDrain(drainId: string): Promise<DrainParkSummary> {
  const result = await pool.query<{
    kind: string;
    parked: number | string;
    resumed: number | string;
  }>(
    `SELECT kind, COUNT(*) AS parked, COUNT(resumed_at) AS resumed
       FROM remote_agent_parked_work
      WHERE drain_id = $1
      GROUP BY kind`,
    [drainId]
  );
  const summary: DrainParkSummary = { parked: emptyCounts(), resumed: emptyCounts() };
  for (const row of result.rows) {
    const key = countKey[parkedWorkKindSchema.parse(row.kind)];
    summary.parked[key] = Number(row.parked);
    summary.resumed[key] = Number(row.resumed);
  }
  return summary;
}
