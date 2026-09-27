/**
 * The agent's to-do checklist, rebuilt from the tool calls that maintain it.
 *
 * Claude keeps its checklist through one of two tool families, and a chat can
 * meet either:
 *
 *  - `TodoWrite` sends the WHOLE list every time, so the latest call is the
 *    list.
 *  - `TaskCreate` / `TaskUpdate` edit it one item at a time, so the list is a
 *    fold over every call in the conversation — an update in this turn can
 *    name a task created three turns ago.
 *
 * Nothing here invents an item. A list the tools never described is `null`,
 * and the view renders nothing for it.
 *
 * Pure and side-effect free so it can be tested without a DOM.
 */

export type ChecklistStatus = 'pending' | 'in_progress' | 'completed';

export interface ChecklistItem {
  id: string;
  text: string;
  status: ChecklistStatus;
}

/** The slice of a tool call the checklist reads. `output` is absent while live. */
export interface ChecklistCall {
  name: string;
  input: Record<string, unknown>;
  output?: string;
}

const CHECKLIST_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);

export function isChecklistCall(call: { name: string }): boolean {
  return CHECKLIST_TOOLS.has(call.name);
}

function toStatus(raw: unknown): ChecklistStatus | null {
  return raw === 'pending' || raw === 'in_progress' || raw === 'completed' ? raw : null;
}

function nonBlank(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/**
 * The id `TaskCreate` reported, read from its output. Absent while the call is
 * live (the stream carries the input only) and when the output is not the
 * JSON the tool documents.
 */
function createdId(output: string | undefined): string | null {
  if (output === undefined) return null;
  try {
    const parsed = JSON.parse(output) as { task?: { id?: unknown } } | null;
    const id = parsed?.task?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

interface Fold {
  items: ChecklistItem[];
  /** The id the next `TaskCreate` without a reported id is assumed to get. */
  next: number;
}

function applyCall(state: Fold, call: ChecklistCall): Fold {
  if (call.name === 'TodoWrite') {
    const todos = call.input.todos;
    if (!Array.isArray(todos)) return state;
    const items = todos.flatMap((raw: unknown, i): ChecklistItem[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const t = raw as Record<string, unknown>;
      const text = nonBlank(t.content);
      const status = toStatus(t.status);
      return text === null || status === null ? [] : [{ id: `todo-${String(i)}`, text, status }];
    });
    return { ...state, items };
  }

  if (call.name === 'TaskCreate') {
    const text = nonBlank(call.input.subject);
    if (text === null) return state;
    // The task tools number sequentially from 1 and never reuse an id, so a
    // live create — whose id is only in the output that has not arrived — is
    // given the next one. The persisted row carries the real id and wins.
    const id = createdId(call.output) ?? String(state.next);
    const n = Number(id);
    return {
      items: [...state.items, { id, text, status: 'pending' }],
      next: Number.isInteger(n) ? Math.max(state.next, n + 1) : state.next,
    };
  }

  if (call.name === 'TaskUpdate') {
    const id = nonBlank(call.input.taskId);
    if (id === null) return state;
    if (call.input.status === 'deleted') {
      return { ...state, items: state.items.filter(item => item.id !== id) };
    }
    const status = toStatus(call.input.status);
    const text = nonBlank(call.input.subject);
    return {
      ...state,
      items: state.items.map(item =>
        item.id === id
          ? { ...item, ...(status !== null ? { status } : {}), ...(text !== null ? { text } : {}) }
          : item
      ),
    };
  }

  return state;
}

/** Fold checklist calls, oldest first, into the list they describe. */
export function foldChecklist(calls: readonly ChecklistCall[]): ChecklistItem[] {
  return calls.filter(isChecklistCall).reduce(applyCall, { items: [], next: 1 }).items;
}

/**
 * The checklist to show under the current turn, or `null` when this turn has
 * not touched it.
 *
 * "This turn" is everything after the last user message, which while idle is
 * the last turn — the same span the status strip's trace reads. A list the
 * agent left behind in an earlier turn is not shown again until it is used:
 * it would otherwise sit under every later reply claiming to be current.
 *
 * `live` is the checklist calls streamed this turn. Tool calls are written to
 * the history when the turn ends, so for its whole length the rows lag the
 * stream; the stored rows win for the calls they already hold, and only the
 * live calls beyond them are added — the same slice-by-count rule as
 * `pendingSegments`, and for the same reason: a `TaskCreate` applied twice is
 * two items.
 */
export function turnChecklist(
  messages: readonly { role: string; toolCalls: readonly ChecklistCall[] }[],
  live: readonly ChecklistCall[]
): ChecklistItem[] | null {
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      turnStart = i + 1;
      break;
    }
  }
  const history = messages.slice(0, turnStart).flatMap(m => m.toolCalls.filter(isChecklistCall));
  const turn = messages.slice(turnStart).flatMap(m => m.toolCalls.filter(isChecklistCall));
  const pending = live.filter(isChecklistCall).slice(turn.length);
  if (turn.length + pending.length === 0) return null;
  return foldChecklist([...history, ...turn, ...pending]);
}
