import type { Project } from '../primitives/project';
import { byMostRecent, matchesFilter } from '../primitives/conversation';
import type { FoundChat } from '../skills/conversations';

/** One row of the ⌘K palette: a project to jump to, or a chat to open. */
export type PaletteResult =
  | { kind: 'project'; project: Project }
  | { kind: 'chat'; found: FoundChat; projectName: string | null };

/** Stable DOM id for a row, unique across both kinds. */
export function paletteResultKey(r: PaletteResult): string {
  return r.kind === 'project' ? `project-${r.project.id}` : `chat-${r.found.chat.id}`;
}

/**
 * What the palette lists for `query`, best first.
 *
 * Projects match as a character subsequence (`c00/A` finds `coleam00/Archon`)
 * and chats as a substring of the title. The subsequence test is loose enough
 * that a phrase from a chat title matches most project names somewhere, so a
 * project that only matches that way ranks BELOW every chat — otherwise typing
 * part of a title and pressing Enter would open a project. A project whose name
 * contains the query outright still leads.
 *
 * An empty query lists every project, then chats most recent first.
 */
export function paletteResults(
  query: string,
  projects: readonly Project[],
  chats: readonly FoundChat[]
): PaletteResult[] {
  const q = query.trim().toLowerCase();
  const names = new Map(projects.map(p => [p.id, p.name]));
  const chatRows: PaletteResult[] = [...chats]
    .filter(f => matchesFilter(f.chat, q))
    .sort((a, b) => byMostRecent(a.chat, b.chat))
    .map(found => ({ kind: 'chat', found, projectName: names.get(found.projectId) ?? null }));

  const strong: PaletteResult[] = [];
  const weak: PaletteResult[] = [];
  for (const project of projects) {
    const name = project.name.toLowerCase();
    if (q.length === 0 || name.includes(q)) strong.push({ kind: 'project', project });
    else if (subsequence(name, q)) weak.push({ kind: 'project', project });
  }
  return [...strong, ...chatRows, ...weak];
}

/** True if `needle` is a subsequence of `haystack` (case-folded by caller). */
function subsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}
