/**
 * The chat rail's multi-selection: which chats a bulk action would touch.
 *
 * Kept apart from the rail so the click rules can be tested without a DOM.
 * The rules are the platform's — Finder, Gmail, every file list:
 *   - a modifier-click (⌘ on a Mac, Ctrl elsewhere) toggles one chat and makes
 *     it the anchor;
 *   - a shift-click selects the run between the anchor and the clicked chat,
 *     in the order the rail draws, replacing whatever was selected.
 */
export interface ChatSelection {
  ids: ReadonlySet<string>;
  /** Where the next shift-click measures from. */
  anchor: string | null;
}

export const EMPTY_SELECTION: ChatSelection = { ids: new Set(), anchor: null };

export function toggleChat(sel: ChatSelection, id: string): ChatSelection {
  const ids = new Set(sel.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/**
 * Select every chat from the anchor to `id`, both ends included.
 *
 * With no anchor the open chat stands in, because it is the one row already
 * highlighted — shift-clicking three rows down from it reads as "from here to
 * there". With neither, or an anchor no longer on screen, the click selects
 * just the chat clicked.
 */
export function selectRange(
  sel: ChatSelection,
  displayed: readonly { id: string }[],
  id: string,
  activeId: string | null
): ChatSelection {
  const anchor = sel.anchor ?? activeId;
  const to = displayed.findIndex(c => c.id === id);
  const from = anchor === null ? -1 : displayed.findIndex(c => c.id === anchor);
  if (to < 0) return sel;
  if (from < 0) return { ids: new Set([id]), anchor: id };
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return { ids: new Set(displayed.slice(lo, hi + 1).map(c => c.id)), anchor };
}
