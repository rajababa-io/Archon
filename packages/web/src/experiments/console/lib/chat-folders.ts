/**
 * Folders in a project's chat list (#396): somewhere to park chats you are not
 * ready to act on without closing them.
 *
 * A folder is only a name carried on each chat in it, so it exists while at
 * least one chat carries that name and vanishes when the last one leaves.
 * There is no folder record to keep in step with the chats.
 *
 * Which folders are open is remembered per browser, like the rail widths: it
 * is how you have arranged THIS screen, not a fact about the chats. Folders
 * start closed, because putting a chat in one is how you ask not to see it.
 */

export interface ChatFolder<T> {
  name: string;
  chats: T[];
}

export interface FolderedChats<T> {
  /** Chats in no folder, in the order they were given. */
  loose: T[];
  /** Every folder that holds a chat, by name; chats keep the order they were given. */
  folders: ChatFolder<T>[];
}

/** Split a list into the chats in no folder and the folders, by name. */
export function groupChatsByFolder<T extends { folder: string | null }>(
  chats: readonly T[]
): FolderedChats<T> {
  const loose: T[] = [];
  const byName = new Map<string, T[]>();
  for (const chat of chats) {
    if (chat.folder === null) {
      loose.push(chat);
      continue;
    }
    const rows = byName.get(chat.folder) ?? [];
    rows.push(chat);
    byName.set(chat.folder, rows);
  }
  const folders = [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(([name, rows]) => ({ name, chats: rows }));
  return { loose, folders };
}

/** localStorage key for one project's open folders. */
export function openFoldersKey(projectId: string): string {
  return `archon.console.openFolders.${projectId}`;
}

/** The folders left open in this project, or none for anything unreadable. */
export function readOpenFolders(projectId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(openFoldersKey(projectId)) ?? '[]');
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    );
  } catch {
    // Blocked storage or a hand-edited value: every folder starts closed, which
    // is the default anyway.
    return new Set();
  }
}

export function writeOpenFolders(projectId: string, open: ReadonlySet<string>): void {
  try {
    localStorage.setItem(openFoldersKey(projectId), JSON.stringify([...open]));
  } catch {
    // Private mode or a full quota: the folder still toggles for this visit,
    // it just is not remembered.
  }
}
