/**
 * Ranking for the `@` file picker: which of a project's paths a few typed
 * letters most likely mean.
 */

/** Lower is better; null is no match. */
function score(path: string, query: string): number | null {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  // The file's own name is what people remember and type.
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (path.includes(query)) return 3;
  // Letters in order anywhere in the path — `cmpsr` finds `Composer.tsx` —
  // tighter spans first, so a scattered match across a deep path sorts last.
  let first = -1;
  let at = 0;
  for (const ch of query) {
    const found = path.indexOf(ch, at);
    if (found === -1) return null;
    if (first === -1) first = found;
    at = found + 1;
  }
  return 4 + (at - first) / path.length;
}

/**
 * The paths a query finds, best first, at most `limit`. Case-insensitive;
 * spaces in the query are ignored, since a path has none worth typing.
 * An empty query finds nothing — the picker asks for letters instead of
 * listing thousands of files in whatever order git keeps them.
 */
export function rankPaths(paths: readonly string[], query: string, limit: number): string[] {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (q === '') return [];
  const scored: { path: string; rank: number }[] = [];
  for (const path of paths) {
    const rank = score(path.toLowerCase(), q);
    if (rank !== null) scored.push({ path, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length);
  return scored.slice(0, limit).map(s => s.path);
}
