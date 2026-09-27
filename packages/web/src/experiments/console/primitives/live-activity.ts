/**
 * Applying a pushed activity event to what the console knows is running.
 *
 * The console's rule is that an SSE event is an invalidation trigger and never
 * state — a run changed, ask the API again. This is one of two deliberate
 * exceptions, and it is here rather than inline in `lib/sse.ts` so the rule it
 * bends is written down and testable.
 *
 * It bends for two reasons. The authority for "what is this chat doing" is a
 * Map in the SERVER's memory, not a row, so a refetch is not more truthful
 * than the event — it is the same fact, fetched. And there is one event per
 * tool call, so a refetch each would make this the busiest request the console
 * makes, to learn what the event already carried.
 *
 * What it must NOT do is invent knowledge. `ActiveChats` absent means "not
 * asked yet", which `useLiveChats` reports as `known: false` and the rail's
 * amber rule depends on: before the first answer, "not working" and "not asked"
 * are the same empty set, and only that flag separates them. An event arriving
 * first must leave the cache absent rather than fabricate a set containing one
 * id and implying every other chat is idle.
 */

import type { ActiveChats, ActiveTool } from '../skills/activeChats';

/** A `conversation_activity` event, as the server sends it. */
export interface ActivityEvent {
  conversationId: string;
  name: string;
  input: Record<string, string>;
}

/**
 * Narrow a parsed SSE payload to an activity event, or null.
 *
 * Read defensively for the same reason `skills/activeChats` is: this shape is
 * not in the generated OpenAPI schema, so a malformed event has to yield
 * nothing rather than a row that renders `undefined`.
 */
export function toActivityEvent(ev: unknown): ActivityEvent | null {
  if (typeof ev !== 'object' || ev === null) return null;
  const { conversationId, name, input } = ev as {
    conversationId?: unknown;
    name?: unknown;
    input?: unknown;
  };
  if (typeof conversationId !== 'string' || conversationId === '') return null;
  if (typeof name !== 'string' || name === '') return null;
  const fields: Record<string, string> = {};
  if (typeof input === 'object' && input !== null) {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof v === 'string') fields[k] = v;
    }
  }
  return { conversationId, name, input: fields };
}

/**
 * The active-chat set with one conversation's tool replaced.
 *
 * The id joins `ids` as well: a tool call is proof the server is executing a
 * turn for that chat, and waiting for the next snapshot to confirm it is the
 * lag this event exists to remove.
 *
 * An ABSENT set stays absent. See the module comment: a set built from one
 * event would claim every other chat is idle on the authority of having heard
 * nothing about them, and the answer to that is already on its way — nothing
 * subscribes to this cache without the loader that fills it.
 */
export function applyActivity(
  prev: ActiveChats | undefined,
  ev: ActivityEvent
): ActiveChats | undefined {
  if (prev === undefined) return undefined;
  const tools: Record<string, ActiveTool> = {
    ...prev.tools,
    [ev.conversationId]: { name: ev.name, input: ev.input },
  };
  const ids = prev.ids.includes(ev.conversationId) ? prev.ids : [...prev.ids, ev.conversationId];
  // Spread, not rebuilt: the snapshot carries more than the two fields an
  // event changes, and a rebuilt object silently dropped the rest.
  return { ...prev, ids, tools };
}

/**
 * The active-chat set with one conversation's tool forgotten.
 *
 * Called when a turn ends. The id is LEFT ALONE: `/api/health` is the authority
 * on which chats are active and it merges in background workflow runs that
 * never take the conversation lock, so dropping the id here would blank a chat
 * that is still working. The tool is safe to drop because the server discards
 * its own `lastTool` at the same moment — the next snapshot agrees.
 *
 * Returns `prev` unchanged when there was nothing to forget, so a no-op cannot
 * cost a re-render.
 */
export function clearActivity(
  prev: ActiveChats | undefined,
  conversationId: string
): ActiveChats | undefined {
  if (prev?.tools[conversationId] === undefined) return prev;
  // Rebuilt without the key rather than deleted from a copy: a computed delete
  // is the one spelling the lint bans, and this object is four entries wide.
  const tools = Object.fromEntries(
    Object.entries(prev.tools).filter(([id]) => id !== conversationId)
  );
  return { ...prev, tools };
}
