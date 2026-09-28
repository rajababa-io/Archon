/** Text edits the composer makes on your behalf: an inserted token, a quote. */

export interface Edited {
  value: string;
  /** Where the caret goes: just after what was inserted. */
  caret: number;
}

/**
 * Put `insert` where the selection is, replacing it, as a word of its own: a
 * space is added before it when it would otherwise run into the text ahead,
 * and after it unless a space already follows.
 */
export function insertWord(value: string, start: number, end: number, insert: string): Edited {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';
  const trail = /^\s/.test(after) ? '' : ' ';
  const placed = `${lead}${insert}${trail}`;
  return { value: `${before}${placed}${after}`, caret: before.length + placed.length };
}

/**
 * A message quoted into the draft, as markdown: every line behind `> `, then a
 * blank line to type the reply under. Added below anything already typed.
 */
export function quoteInto(draft: string, quoted: string): Edited {
  const block = quoted
    .trim()
    .split('\n')
    .map(line => (line === '' ? '>' : `> ${line}`))
    .join('\n');
  const head = draft.trimEnd();
  const value = `${head === '' ? '' : `${head}\n\n`}${block}\n\n`;
  return { value, caret: value.length };
}

/**
 * A command chosen from the `/` sheet, put at the start of the draft where the
 * server looks for it. What was already typed follows it as the command's
 * argument; a command already there is replaced, arguments and all.
 */
export function withCommand(draft: string, insert: string): Edited {
  const rest = draft.startsWith('/') ? '' : draft.trimStart();
  return { value: `${insert}${rest}`, caret: insert.length };
}
