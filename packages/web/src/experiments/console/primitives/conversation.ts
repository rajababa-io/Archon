/** Conversation summary primitive. Normalized from the server conversation row. */
/**
 * The colors a chat can be labeled with, paired with the design token that
 * renders each. Copied from `@archon/core`'s CONVERSATION_COLORS rather than
 * imported — the console may not import production modules (ESLint isolation
 * rule) — so the two lists must change together.
 *
 * Names, not hex: the server stores the name and the UI owns the rendering, so
 * re-theming never has to rewrite stored rows.
 *
 * EVERY TOKEN COMES FROM THE LABEL PALETTE, and none from --accent or a status
 * colour. Six labels only work if they stay mutually distinguishable, and a
 * label borrowing a token that answers to something else cannot promise that:
 * pointing magenta and violet at --accent rendered them the same pixel, and
 * amber on --warning would have followed a status retune into green. The
 * --lbl-* ramp in tokens.css exists for this and answers to nothing else.
 * `conversation.test.ts` fails if any two share a token.
 */
export const CONVERSATION_COLORS = [
  { value: 'magenta', label: 'Magenta', token: 'var(--lbl-plum)' },
  { value: 'violet', label: 'Violet', token: 'var(--lbl-violet)' },
  { value: 'blue', label: 'Blue', token: 'var(--lbl-blue)' },
  { value: 'green', label: 'Green', token: 'var(--lbl-green)' },
  { value: 'amber', label: 'Amber', token: 'var(--lbl-amber)' },
  { value: 'red', label: 'Red', token: 'var(--lbl-rose)' },
] as const;

export type ConversationColor = (typeof CONVERSATION_COLORS)[number]['value'];

export interface ConversationSummary {
  /**
   * Platform conversation id (`web-<ts>-<rand>`) — NOT the DB uuid. This is the
   * id the `/api/conversations/:id/messages` and `/api/stream/:id` routes accept.
   */
  id: string;
  /**
   * Conversation DB uuid. This is what a run's `parent_conversation_id` points
   * at, so it — not `id` — is the key for "runs launched from this chat".
   */
  dbId: string;
  title: string | null;
  platformType: string;
  lastActivityAt: string | null;
  /** User-chosen color label, or null for none. */
  color: ConversationColor | null;
  /**
   * Which assistant answers this chat — `claude`, `codex`, `pi`, a community
   * provider id. Set when the chat is created and stored on the row, so it is
   * real provenance rather than a guess from the current default.
   */
  assistant: string;
  /**
   * A human marked this chat's unit of work finished.
   *
   * The chat's whole lifecycle: open or done. There was a second flag here —
   * `archived` — and two flags over one idea made four states, two of which
   * nobody could read ("filed but never finished", "finished and filed"). The
   * console does not list soft-deleted rows at all now, so there is nothing
   * left for the second flag to say.
   */
  completed: boolean;
  /**
   * This chat's newest message, when the server thinks it might hold an ask
   * block — its test is deliberately broad, so this still has to be parsed
   * before it means anything. Null when there is nothing worth looking at.
   */
  askCandidate: string | null;
  /**
   * Hand-arranged position in the rail, ascending, or `null` for a chat that
   * has never been placed. Stored on the row, so the arrangement follows the
   * reader to any browser rather than living in one machine's localStorage.
   */
  sortOrder: number | null;
  /**
   * When a human last read this chat to the end, or null for never.
   *
   * Only meaningful beside `lastActivityAt` — unread is the pair, not either
   * one. Carried raw so the comparison happens in one place (`unreadIds`)
   * rather than being decided here and again wherever the rail draws.
   */
  lastReadAt: string | null;
  /**
   * The agent says this chat's work is finished and nobody has confirmed it.
   *
   * A boolean, not the timestamp, because nothing compares it to anything —
   * unlike `lastReadAt`, which is only meaningful beside `lastActivityAt`. The
   * claim either stands or it does not.
   *
   * Distinct from `completed`, which is the human's answer to the same
   * question. A chat can be ready and not done; once it is done the server has
   * already cleared this, so it cannot be both.
   */
  ready: boolean;
  /**
   * The project (codebase id) this chat belongs to, or null for a chat with
   * none. A project's own list never needs it; the every-project list does,
   * to say whose chat a row is and where its runs and drafts live.
   */
  projectId: string | null;
  /** Short summary of the chat, or null when nothing has written one yet. */
  /** When the summary was last written — what makes staleness visible. */
  /** True when a human wrote it, so the agent leaves it alone. */
}

interface RawConversation {
  id: string;
  platform_conversation_id: string;
  platform_type: string;
  title: string | null;
  last_activity_at: string | null;
  color: string | null;
  ai_assistant_type: string;
  completed_at?: string | null;
  sort_order?: number | null;
  ask_candidate?: string | null;
  last_read_at?: string | null;
  ready_at?: string | null;
  codebase_id?: string | null;
}

/**
 * The wire shape as the console needs it. Everything the server sends that the
 * rail does not read is dropped here rather than carried.
 */
export function toConversationSummary(raw: RawConversation): ConversationSummary {
  return {
    id: raw.platform_conversation_id,
    dbId: raw.id,
    title: raw.title,
    platformType: raw.platform_type,
    lastActivityAt: raw.last_activity_at,
    color: parseConversationColor(raw.color),
    assistant: raw.ai_assistant_type,
    // The timestamp IS the state, so there is no second boolean that can
    // disagree with it. Absent — including from a server that predates the
    // column — reads as not finished.
    completed: raw.completed_at != null,
    askCandidate: raw.ask_candidate ?? null,
    // `?? null` covers a server that predates the column, which reads as
    // never arranged rather than as position zero.
    sortOrder: raw.sort_order ?? null,
    // Absent — including from a server that predates the column — reads as
    // never read. That over-reports unread rather than hiding a message, which
    // is the only direction this may fail in.
    lastReadAt: raw.last_read_at ?? null,
    // The timestamp IS the state here too. Absent — including from a server
    // that predates the column — reads as no claim, which under-reports rather
    // than over-reports: a missing mark costs a glance, a false one would say
    // work had landed when it had not.
    ready: raw.ready_at != null,
    projectId: raw.codebase_id ?? null,
  };
}

/**
 * Normalise a stored color. Anything unrecognised — written by a newer build,
 * or hand-edited — reads as no color rather than rendering a blank swatch.
 */
export function parseConversationColor(raw: string | null | undefined): ConversationColor | null {
  return CONVERSATION_COLORS.some(c => c.value === raw) ? (raw as ConversationColor) : null;
}

/** The design token that renders a color, or null when the chat has none. */
export function colorToken(color: ConversationColor | null): string | null {
  return CONVERSATION_COLORS.find(c => c.value === color)?.token ?? null;
}

/** Fallback shown before the server's auto-title lands on a fresh chat. */
export const UNTITLED_CHAT = 'Untitled chat';

/**
 * What to show in the switcher. A conversation has no title until the server
 * generates one from the first message, so a brand-new chat would otherwise
 * render as a blank row.
 */
export function conversationLabel(c: ConversationSummary): string {
  const title = c.title?.trim() ?? '';
  return title.length > 0 ? title : UNTITLED_CHAT;
}

/**
 * Most recently active first, so the switcher opens on what the user was last
 * doing. Conversations that have never been active sort last rather than
 * jumping to the top on an unparsable date.
 */
export function byMostRecent(a: ConversationSummary, b: ConversationSummary): number {
  const at = a.lastActivityAt ?? '';
  const bt = b.lastActivityAt ?? '';
  if (at === bt) return 0;
  if (at === '') return 1;
  if (bt === '') return -1;
  return at < bt ? 1 : -1;
}

/**
 * The rail's order: where the user put it, and recency only where they have
 * not said.
 *
 * A chat with no position yet leads. That is the opposite of the project
 * rail's rule and deliberate — a project you just added can wait at the bottom
 * of a short rail, a chat you just started cannot. Those chats stay in recency
 * order among themselves, so the newest is first.
 *
 * Two chats can legitimately hold the same position: the rail renumbers only
 * the chats it is showing, one scope at a time, so a done chat may share a
 * value with an open one. They meet only under "All", and recency breaks the
 * tie so the list never wobbles between two answers.
 */
export function byArrangement(a: ConversationSummary, b: ConversationSummary): number {
  const ao = a.sortOrder;
  const bo = b.sortOrder;
  if (ao === null || bo === null) {
    if (ao === bo) return byMostRecent(a, b);
    return ao === null ? -1 : 1;
  }
  return ao === bo ? byMostRecent(a, b) : ao - bo;
}

/**
 * Two-letter monogram for a chat's tile, mirroring the project rail's rows.
 *
 * Initials of the first two words when there are two, otherwise the first two
 * letters. Falls back to `??` rather than rendering an empty tile, which reads
 * as a loading state that never resolves.
 */
export function conversationMonogram(c: ConversationSummary): string {
  const label = conversationLabel(c);
  const words = label.split(/\s+/).filter(w => /[a-z0-9]/i.test(w));
  if (words.length >= 2) {
    const a = words[0]?.[0] ?? '';
    const b = words[1]?.[0] ?? '';
    const pair = `${a}${b}`.toUpperCase();
    if (pair.length === 2) return pair;
  }
  const letters = label.replace(/[^a-z0-9]/gi, '');
  return letters.length > 0 ? letters.slice(0, 2).toUpperCase() : '??';
}

/**
 * Case-insensitive substring match on the title, for the rail's filter box.
 * An empty query matches everything, so clearing the box restores the list
 * rather than emptying it.
 */
export function matchesFilter(c: ConversationSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return conversationLabel(c).toLowerCase().includes(q);
}

/**
 * The DB uuid behind a platform conversation id. A run's
 * `parent_conversation_id` points at the uuid, while the routes that carry a
 * chat around the console carry the platform id, so every "runs launched from
 * this chat" lookup has to cross this one join. Returns `null` when no chat is
 * open, or for the moment between creating one and the list refetching.
 */
export function resolveConversationDbId(
  conversations: ConversationSummary[],
  platformConversationId: string | null
): string | null {
  if (platformConversationId === null) return null;
  return conversations.find(c => c.id === platformConversationId)?.dbId ?? null;
}
