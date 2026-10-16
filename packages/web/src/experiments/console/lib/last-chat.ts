/**
 * The chat a project was last reading, so a reload or a trip to another
 * project comes back to it rather than to whichever chat is newest.
 *
 * localStorage, like the console's other UI preferences. Per project, so one
 * project's choice never selects a chat in another.
 */

const KEY_PREFIX = 'archon.console.lastChat.';

export function lastChatKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

export function readLastChat(projectId: string): string | null {
  try {
    const raw = localStorage.getItem(lastChatKey(projectId));
    return raw !== null && raw.length > 0 ? raw : null;
  } catch {
    // Storage throws with cookies disabled and in some private-browsing modes.
    return null;
  }
}

export function writeLastChat(projectId: string, conversationId: string | null): void {
  try {
    if (conversationId === null) localStorage.removeItem(lastChatKey(projectId));
    else localStorage.setItem(lastChatKey(projectId), conversationId);
  } catch {
    // Best-effort: failing to remember must never break navigating.
  }
}

/**
 * Which chat to open: the remembered one when it still exists, otherwise the
 * most recent chat in no folder. A remembered id that has been archived or
 * deleted must not win, or the project opens on nothing.
 *
 * The fallback passes over filed chats (#396): a folder holding the open chat
 * is drawn open, so landing on a parked chat would unfold what you put away.
 * Only when every chat is filed does it open one anyway.
 */
export function chooseOpenChat(
  remembered: string | null,
  available: readonly { id: string; folder?: string | null }[]
): string | null {
  if (remembered !== null && available.some(c => c.id === remembered)) return remembered;
  return (available.find(c => c.folder == null) ?? available[0])?.id ?? null;
}

/**
 * Which chat to open when the one being read leaves the list.
 *
 * The chat below it as displayed, else the one above it, else nothing. Landing
 * on a neighbour is what makes archiving several chats in a row feel like
 * working down the rail; stepping out to a blank new chat each time reads as
 * the page throwing the user out.
 *
 * `leaving` is every chat going at once — a bulk archive must not select one of
 * its own casualties.
 */
export function chooseNeighbourChat(
  displayed: readonly { id: string }[],
  activeId: string,
  leaving: readonly string[]
): string | null {
  const gone = new Set(leaving);
  const at = displayed.findIndex(c => c.id === activeId);
  // Not on screen — filtered out, or already gone. Nothing to stay next to.
  if (at < 0) return null;
  for (let i = at + 1; i < displayed.length; i++) {
    const id = displayed[i]?.id;
    if (id !== undefined && !gone.has(id)) return id;
  }
  for (let i = at - 1; i >= 0; i--) {
    const id = displayed[i]?.id;
    if (id !== undefined && !gone.has(id)) return id;
  }
  return null;
}
