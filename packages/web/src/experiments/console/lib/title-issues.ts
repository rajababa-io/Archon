/**
 * The issue numbers a chat title leads with.
 *
 * A chat that works on an issue is titled with its numbers first —
 * `#96 Ask card`, `#97 #98 Deploy wait`, and for four or more `#99 +3 Console
 * polish`. The title is stored as plain text; the numbers are found here, when
 * the title is drawn, so nothing about a title's storage changes.
 *
 * Only the LEADING run counts. `Fix the #3 regression` names an issue in
 * passing and is not a claim that the chat works on it.
 */

/**
 * One piece of a title. Joining every `text` gives the title back exactly, so
 * a title with no numbers draws character-for-character as it always did.
 */
export type TitlePart =
  | { kind: 'issue'; text: string; number: number }
  /** The `+3` of the four-or-more form. Not a link: the numbers it stands for are not in the title. */
  | { kind: 'more'; text: string }
  | { kind: 'text'; text: string };

// A token ends at whitespace or the end of the title, so `#96abc` is a word,
// not issue 96. Issue numbers start at 1.
const ISSUE = /^#([1-9]\d*)(?=\s|$)/;
const MORE = /^\+[1-9]\d*(?=\s|$)/;
const SPACE = /^\s+/;

export function titleParts(title: string): TitlePart[] {
  const parts: TitlePart[] = [];
  let rest = title;
  let seenIssue = false;
  let seenMore = false;

  for (;;) {
    const issue = seenMore ? null : ISSUE.exec(rest);
    // `+N` counts only after at least one number, and only once.
    const more = seenIssue && !seenMore ? MORE.exec(rest) : null;
    if (issue !== null) {
      parts.push({ kind: 'issue', text: issue[0], number: Number(issue[1]) });
      seenIssue = true;
      rest = rest.slice(issue[0].length);
    } else if (more !== null) {
      parts.push({ kind: 'more', text: more[0] });
      seenMore = true;
      rest = rest.slice(more[0].length);
    } else {
      break;
    }
    const space = SPACE.exec(rest);
    if (space === null) break;
    parts.push({ kind: 'text', text: space[0] });
    rest = rest.slice(space[0].length);
  }

  if (rest.length > 0) parts.push({ kind: 'text', text: rest });
  return parts;
}
