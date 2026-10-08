/**
 * Splits brief prose into text runs and links (#371).
 *
 * Deliberately not markdown. The brief is plain prose, and a markdown renderer
 * would also eat the stars, underscores and backticks a brief happens to
 * contain. Only two shapes become links: a bare `http(s)://` address, and
 * `[label](http(s)://…)` so the agent can name a link instead of printing it.
 * Everything else comes back as the exact text it was.
 */
export type BriefSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; href: string; label: string };

// One pass, labelled form first so its address is not also matched bare.
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"]+/g;

/**
 * Punctuation that ends a sentence, not an address: "see https://x.dev/a."
 * links `https://x.dev/a`. A closing paren stays when the address opened one,
 * as Wikipedia-style paths do.
 */
function trimTrailing(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last === undefined) break;
    if ('.,;:!?\'"'.includes(last)) {
      end--;
      continue;
    }
    if (last === ')') {
      const head = url.slice(0, end);
      const opens = head.split('(').length - 1;
      const closes = head.split(')').length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

export function splitBriefLinks(text: string): BriefSegment[] {
  const out: BriefSegment[] = [];
  let cursor = 0;
  for (const m of text.matchAll(LINK)) {
    let consumed: string;
    let segment: BriefSegment;
    if (m[1] !== undefined && m[2] !== undefined) {
      consumed = m[0];
      segment = { kind: 'link', href: m[2], label: m[1] };
    } else {
      consumed = trimTrailing(m[0]);
      // "https://" alone, or followed only by punctuation, names no host.
      if (!/^https?:\/\/[^/?#]/.test(consumed)) continue;
      segment = { kind: 'link', href: consumed, label: consumed };
    }
    if (m.index > cursor) out.push({ kind: 'text', text: text.slice(cursor, m.index) });
    out.push(segment);
    cursor = m.index + consumed.length;
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
  return out;
}
