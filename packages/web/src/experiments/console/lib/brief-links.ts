/**
 * The web addresses in a project brief field, found so they can be clicked.
 *
 * The brief is plain text the agent writes; it is not rendered as markdown, so
 * a stray `*` or `#` in it stays what it is. Only two shapes become links: a
 * bare `http(s)://` address, and the markdown `[label](https://…)` form when an
 * address deserves a name. Anything else — `javascript:`, `mailto:`, a bare
 * domain — stays text, so a brief can never carry a link the reader did not
 * see spelled out as a web address.
 */

/** One piece of a field. Joining every `text` gives the field back exactly. */
export type BriefPart =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string; label: string };

// Group 1/2: `[label](url)`. Group 3: a bare address, cut at whitespace or `<>`.
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/gi;

// Punctuation that ends a sentence or a list item, not an address. `·` is the
// separator the briefs use between links.
const TRAILING = /[.,;:!?'"·]$/;

/**
 * A bare address loses trailing punctuation, and a closing `)` it never
 * opened — `(see https://a.example)` links `https://a.example`, while
 * `https://en.wikipedia.org/wiki/X_(y)` keeps its own parenthesis.
 */
function trimBare(url: string): string {
  let end = url;
  for (;;) {
    if (TRAILING.test(end)) {
      end = end.slice(0, -1);
      continue;
    }
    if (end.endsWith(')') && count(end, ')') > count(end, '(')) {
      end = end.slice(0, -1);
      continue;
    }
    return end;
  }
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

export function briefParts(value: string): BriefPart[] {
  const parts: BriefPart[] = [];
  const push = (text: string): void => {
    if (text === '') return;
    const last = parts.at(-1);
    if (last?.kind === 'text') last.text += text;
    else parts.push({ kind: 'text', text });
  };

  let at = 0;
  for (const m of value.matchAll(LINK)) {
    const start = m.index;
    push(value.slice(at, start));
    if (m[1] !== undefined && m[2] !== undefined) {
      parts.push({ kind: 'link', text: m[0], href: m[2], label: m[1] });
      at = start + m[0].length;
    } else {
      const href = trimBare(m[0]);
      // `https://` alone, or one eaten entirely by punctuation, is not an address.
      if (/^https?:\/\/.+/i.test(href)) {
        parts.push({ kind: 'link', text: href, href, label: href });
      } else {
        push(href);
      }
      at = start + href.length;
    }
  }
  push(value.slice(at));
  return parts;
}
