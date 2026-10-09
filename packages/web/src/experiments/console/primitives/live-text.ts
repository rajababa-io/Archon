/**
 * Live assistant text — the part of a reply that has been streamed but not yet
 * written to the database.
 *
 * The server emits each piece of assistant text over SSE the moment it is
 * produced, but it buffers that text in memory and writes it as message rows
 * only at the end of the turn or on a 30-second periodic flush
 * (`adapters/web/persistence.ts`). The console renders from the database, so
 * treating an SSE event purely as "refetch now" asks for a row that does not
 * exist yet: the refetch returns the old list, no further event arrives, and
 * the reply stays invisible until something else triggers a read. That is why a
 * reply could only be revealed by reloading the page.
 *
 * The buffer is deliberately NOT fixed by persisting sooner. Buffered text is
 * provisional: `emitRetract` drops the last segment when the orchestrator's
 * reply turns out to be a workflow dispatch, and it can only do that while the
 * text is still in memory. Writing text early would leave retracted prose in
 * the history forever. So the lateness is load-bearing, and the right place to
 * fix the symptom is the view: show the streamed text immediately, and let the
 * database stay authoritative.
 *
 * These functions mirror the server's segmentation rules so the preview can be
 * matched against the rows that eventually land, without comparing content.
 */

/** Categories the server treats as their own bubble rather than appending to the previous one. */
const STANDALONE_CATEGORIES = ['workflow_status', 'workflow_dispatch_status'] as const;

function isStandalone(category: string | null): boolean {
  return STANDALONE_CATEGORIES.some(c => c === category);
}

/**
 * One streamed segment — the client's mirror of a `BufferedSegment`. Each
 * segment becomes exactly one assistant row when the server flushes, so a
 * count of segments can be matched against a count of rows.
 */
export interface LiveSegment {
  content: string;
  category: string | null;
  /**
   * Whether a tool call has landed in this segment. The server starts a new
   * segment for text that follows a tool call, so the preview must too.
   */
  hasTools: boolean;
  /** Streamed thinking that came before this segment's text. Absent when there was none. */
  thinking?: string;
}

export type LiveEvent =
  | { kind: 'text'; content: string; category: string | null }
  /** `name` and `input` ride along for readers other than the segmenter, which ignores them. */
  | { kind: 'tool'; name?: string; input?: Record<string, unknown> }
  | { kind: 'thinking'; content: string }
  | { kind: 'retract' }
  /** The stream (re)opened: whatever it carried before is no longer known to be whole. */
  | { kind: 'rejoin' };

/** Whether a segment or row has anything a reader would see. */
function hasSubstance(s: { content: string; thinking?: string | null }): boolean {
  return s.content.trim().length > 0 || (s.thinking ?? '').trim().length > 0;
}

/**
 * Fold one streamed event into the segment list.
 *
 * Mirrors `MessagePersistence.appendText`: text extends the current segment
 * unless that segment already holds a tool call, or either side of the join is
 * a standalone category. Tool calls do not open a segment of their own here —
 * a tool-only segment persists with empty content and renders nothing, so
 * counting it would put the preview out of step with the rows.
 *
 * Pure: returns a new array and never mutates its input.
 */
export function reduceLive(segments: LiveSegment[], event: LiveEvent): LiveSegment[] {
  const last = segments[segments.length - 1];

  if (event.kind === 'rejoin') return [];

  if (event.kind === 'retract') {
    // Mirrors `retractLastSegment`: a segment that carries tool calls survives
    // with its text cleared, anything else goes.
    if (last === undefined) return segments;
    if (last.hasTools) {
      return [...segments.slice(0, -1), { ...last, content: '' }];
    }
    return segments.slice(0, -1);
  }

  if (event.kind === 'thinking') {
    // Mirrors `MessagePersistence.appendThinking`: thinking opens a segment of
    // its own unless the current one holds nothing but thinking so far.
    if (last?.content === '' && !last.hasTools) {
      const thinking = last.thinking ? `${last.thinking}\n\n${event.content}` : event.content;
      return [...segments.slice(0, -1), { ...last, thinking }];
    }
    return [...segments, { content: '', category: null, hasTools: false, thinking: event.content }];
  }

  if (event.kind === 'tool') {
    if (last === undefined) return segments;
    if (last.hasTools) return segments;
    return [...segments.slice(0, -1), { ...last, hasTools: true }];
  }

  const needsNewSegment =
    last === undefined ||
    last.hasTools ||
    isStandalone(event.category) ||
    isStandalone(last.category);

  if (needsNewSegment) {
    return [...segments, { content: event.content, category: event.category, hasTools: false }];
  }

  return [...segments.slice(0, -1), { ...last, content: last.content + event.content }];
}

/** A stored row as the preview reads it. `id` places the turn's user row. */
interface StoredRow {
  id?: string;
  role: string;
  content: string;
  thinking?: string | null;
}

/**
 * How many assistant rows of the current turn are already in the database.
 *
 * Counts back to the last user message, and only rows that carry text or
 * thinking — a tool-only row persists with empty content and has no matching
 * segment in the preview. The result is how many leading segments the database has caught up
 * with.
 */
export function persistedSegmentCount(messages: readonly StoredRow[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role === 'user') break;
    // Only the agent's own rows are segments. A `system` notice — a handoff
    // saying why it happened — sits in the same span and carries content, so
    // counting it would report one more segment persisted than there are and
    // silently swallow the last live one.
    if (m.role !== 'assistant') continue;
    if (hasSubstance(m)) count++;
  }
  return count;
}

/**
 * Where this tab joined the turn it is previewing: how many of the turn's rows
 * were already stored, and the user row that turn hangs from.
 *
 * The preview holds only what this tab streamed. A tab that opens the chat
 * mid-turn, or whose stream reconnects, missed the segments before that, so
 * counting stored rows from the start of the turn over-counts them, and the
 * slice drops segments that were never shown — a finished reply could vanish
 * until reload (#375). The count is tied to its user row because a turn that
 * starts after the join begins counting from zero again.
 */
export interface JoinPoint {
  stored: number;
  userRowId: string | null;
}

/**
 * What a chat screen previews: the segments it streamed, and where it joined.
 * `joined` is `null` until the first event says the tab is watching a turn.
 */
export interface LivePreview {
  segments: LiveSegment[];
  joined: JoinPoint | null;
}

/** Nothing streamed, join not yet measured: a fresh stream or a new chat. */
export const UNJOINED: LivePreview = { segments: [], joined: null };

/** A turn this tab started itself: it streams every segment, so nothing was missed. */
export const FROM_TURN_START: LivePreview = {
  segments: [],
  joined: { stored: 0, userRowId: null },
};

function lastUserRowId(messages: readonly StoredRow[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return m.id ?? null;
  }
  return null;
}

/**
 * Fold one streamed event into the preview, measuring the join on the first
 * event after an unjoined start against the rows stored at that moment. A
 * rejoin forgets both: the stream that held them is gone.
 */
export function advanceLive(
  preview: LivePreview,
  event: LiveEvent,
  stored: readonly StoredRow[]
): LivePreview {
  if (event.kind === 'rejoin') return UNJOINED;
  const joined = preview.joined ?? {
    stored: persistedSegmentCount(stored),
    userRowId: lastUserRowId(stored),
  };
  return { segments: reduceLive(preview.segments, event), joined };
}

/**
 * The segments that still need previewing: everything the database has not
 * caught up with yet, counting only rows stored since this tab joined.
 *
 * Slicing rather than clearing is what makes this self-correcting. If the
 * mirror of the server's segmentation is ever wrong, the error lasts until the
 * next flush and then disappears — the database, not the preview, decides what
 * the history says.
 */
export function pendingSegments(
  segments: LiveSegment[],
  messages: readonly StoredRow[],
  joined: JoinPoint | null = null
): LiveSegment[] {
  const missed =
    joined !== null && joined.userRowId === lastUserRowId(messages) ? joined.stored : 0;
  const pending = segments.slice(Math.max(0, persistedSegmentCount(messages) - missed));
  return pending.filter(hasSubstance);
}
