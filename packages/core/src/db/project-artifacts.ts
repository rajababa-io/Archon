/**
 * The two row sets the project artifact index (#351) is built from.
 *
 * Neither is a copy of an artifact. Run artifacts stay in each run's directory
 * and handoff documents stay where the handoff tool wrote them; these queries
 * only name WHICH runs and WHICH handoffs belong to a project, with the chat
 * each one came from, so the server can list a bounded few rather than walk
 * every run the project ever had.
 */
import { pool, getDatabaseType } from './connection';
import { toHydratedTimestamp } from './timestamps';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';

/** The chat a run or a handoff belongs to, with its two stored marks. */
export interface ArtifactChat {
  /** Platform conversation id — the one the console's rail keys chats by. */
  id: string;
  title: string | null;
  /** A human said the work landed. */
  done: boolean;
  /** The agent says the work landed and is waiting for a human to agree. */
  ready: boolean;
}

export interface ArtifactRunRow {
  id: string;
  workflow_name: string;
  status: WorkflowRunStatus;
  output_root: string | null;
  started_at: Date;
  completed_at: Date | null;
  last_activity_at: Date | null;
  chat: ArtifactChat | null;
}

export interface HandoffSeedRow {
  /** The seed message's id — the handle the document is read back through. */
  id: string;
  /** Raw message metadata, JSON text; `readLineage` interprets it. */
  metadata: string;
  created_at: Date;
  chat: ArtifactChat;
}

interface ChatColumns {
  chat_id: string | null;
  chat_title: string | null;
  chat_completed_at: Date | string | null;
  chat_ready_at: Date | string | null;
}

function chatOf(row: ChatColumns): ArtifactChat | null {
  if (row.chat_id === null) return null;
  return {
    id: row.chat_id,
    title: row.chat_title,
    done: row.chat_completed_at !== null,
    ready: row.chat_ready_at !== null,
  };
}

const hydrate = (v: Date | string): Date => (typeof v === 'string' ? toHydratedTimestamp(v) : v);
const hydrateNullable = (v: Date | string | null): Date | null => (v === null ? null : hydrate(v));

/**
 * The project's newest runs, newest first, with the chat that started each.
 * The chat is the PARENT conversation — the worker conversation a run executes
 * in is not a chat anyone opens. A deleted chat reads as none.
 */
export async function listArtifactRuns(
  codebaseId: string,
  limit: number
): Promise<ArtifactRunRow[]> {
  const result = await pool.query<
    Omit<ArtifactRunRow, 'chat' | 'started_at' | 'completed_at' | 'last_activity_at'> &
      ChatColumns & {
        started_at: Date | string;
        completed_at: Date | string | null;
        last_activity_at: Date | string | null;
      }
  >(
    `SELECT r.id, r.workflow_name, r.status, r.output_root,
            r.started_at, r.completed_at, r.last_activity_at,
            pc.platform_conversation_id AS chat_id, pc.title AS chat_title,
            pc.completed_at AS chat_completed_at, pc.ready_at AS chat_ready_at
     FROM remote_agent_workflow_runs r
     LEFT JOIN remote_agent_conversations pc
       ON pc.id = r.parent_conversation_id AND pc.deleted_at IS NULL
     WHERE r.codebase_id = $1
     ORDER BY r.started_at DESC
     LIMIT $2`,
    [codebaseId, limit]
  );
  return result.rows.map(row => ({
    id: row.id,
    workflow_name: row.workflow_name,
    status: row.status,
    output_root: row.output_root,
    started_at: hydrate(row.started_at),
    completed_at: hydrateNullable(row.completed_at),
    last_activity_at: hydrateNullable(row.last_activity_at),
    chat: chatOf(row),
  }));
}

/** The JSON filter for "this message carries handoff lineage", per dialect. */
function handoffFilter(): string {
  return getDatabaseType() === 'postgresql'
    ? "(m.metadata->'handoff') IS NOT NULL"
    : "json_extract(m.metadata, '$.handoff') IS NOT NULL";
}

interface SeedColumns extends ChatColumns {
  id: string;
  metadata: unknown;
  created_at: Date | string;
}

function seedOf(row: SeedColumns): HandoffSeedRow | null {
  const chat = chatOf(row);
  if (chat === null) return null;
  return {
    id: row.id,
    // PostgreSQL hands JSONB back parsed, SQLite as text; one shape for the reader.
    metadata: typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata),
    created_at: hydrate(row.created_at),
    chat,
  };
}

const SEED_COLUMNS = `m.id, m.metadata, m.created_at,
            c.platform_conversation_id AS chat_id, c.title AS chat_title,
            c.completed_at AS chat_completed_at, c.ready_at AS chat_ready_at`;

/**
 * The project's handoffs, newest first: the seed message of every chat that a
 * handoff opened. The relay writes the document's path into that message's
 * metadata (see `lineageMetadata`), and the successor chat carries the
 * project, so this is the one place a handoff and its project meet.
 */
export async function listHandoffSeeds(
  codebaseId: string,
  limit: number
): Promise<HandoffSeedRow[]> {
  const result = await pool.query<SeedColumns>(
    `SELECT ${SEED_COLUMNS}
     FROM remote_agent_messages m
     JOIN remote_agent_conversations c ON c.id = m.conversation_id
     WHERE c.codebase_id = $1 AND c.deleted_at IS NULL
       AND m.role = 'user' AND ${handoffFilter()}
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [codebaseId, limit]
  );
  return result.rows.map(seedOf).filter((r): r is HandoffSeedRow => r !== null);
}

/** One handoff seed, only if it belongs to this project. */
export async function getHandoffSeed(
  codebaseId: string,
  messageId: string
): Promise<HandoffSeedRow | null> {
  const result = await pool.query<SeedColumns>(
    `SELECT ${SEED_COLUMNS}
     FROM remote_agent_messages m
     JOIN remote_agent_conversations c ON c.id = m.conversation_id
     WHERE m.id = $1 AND c.codebase_id = $2 AND c.deleted_at IS NULL
       AND m.role = 'user' AND ${handoffFilter()}`,
    [messageId, codebaseId]
  );
  const row = result.rows[0];
  return row === undefined ? null : seedOf(row);
}
