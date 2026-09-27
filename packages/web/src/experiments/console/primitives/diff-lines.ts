/**
 * A unified diff split into lines the panel can colour.
 *
 * Classified by each line's first character, which is the unified-diff format
 * itself rather than a guess: `+`/`-` inside a hunk are changes, `@@` opens a
 * hunk, a space is context, and everything before the first hunk is the file
 * header (`diff --git`, `index`, `---`, `+++`, rename lines).
 */
export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context' | 'note';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export function diffLines(patch: string): DiffLine[] {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let inHunk = false;
  return lines.map(text => {
    if (text.startsWith('@@')) {
      inHunk = true;
      return { kind: 'hunk', text };
    }
    if (text.startsWith('diff --git')) inHunk = false;
    if (!inHunk) return { kind: 'meta', text };
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    // "\ No newline at end of file"
    if (text.startsWith('\\')) return { kind: 'note', text };
    return { kind: 'context', text };
  });
}
