/**
 * Ask blocks — the agent's multiple-choice questions, rendered as something you
 * can click instead of something you have to answer by typing a letter.
 *
 * The agent writes a fenced ```ask block holding JSON. The chat splits a reply
 * on those fences and renders the blocks as cards, leaving the prose around
 * them as ordinary markdown.
 *
 * The fence is the contract, and it degrades safely. A client that does not
 * know about ask blocks — an older bundle, a Telegram relay, a plain-text
 * export — renders the JSON as a code block, which is ugly but complete: every
 * question and option is still legible. Nothing is hidden behind the renderer.
 *
 * In the console, though, that same rendering means the opposite: a block that
 * should have been a card and came out as JSON is a bug, not a fallback. The
 * two were indistinguishable until a malformed block shipped unnoticed, so the
 * parser now returns why it refused and the console shows it. The parser is
 * the only reader that sees a finished reply with certainty — a Stop hook
 * reading the transcript races the flush and passes everything — which is why
 * the check lives here rather than in a hook.
 *
 * This file is the one definition of what an ask block is. The console renders
 * cards with it and the server decides whether a chat is waiting on a question
 * with it (`awaiting.ts`), so the two cannot disagree about the same message.
 */

export interface AskOption {
  /** Short label — the choice itself, e.g. "Dead — archive it." */
  label: string;
  /** Optional reasoning shown under the label. */
  detail?: string;
  /** At most one option per question should set this. */
  recommended?: boolean;
  /** Why this one is recommended. Only meaningful with `recommended`. */
  why?: string;
}

export interface AskQuestion {
  /** The question itself. */
  title: string;
  /** Optional evidence paragraph shown above the question. */
  evidence?: string;
  /** Optional label for the subject of the question, shown as a chip. */
  chip?: string;
  options: AskOption[];
  /** Whether to offer a free-text answer. Defaults to true. */
  allowOwn?: boolean;
  /**
   * Whether more than one option can be chosen. Defaults to false — a question
   * asks for a decision, and letting every question take a set would quietly
   * turn "which one" into "which of these", which is a different question.
   */
  multi?: boolean;
}

export interface AskSpec {
  questions: AskQuestion[];
}

/**
 * A reply is a sequence of prose runs, ask cards, and — when a block claimed to
 * be an ask block but was not one — the wreckage, reported rather than hidden.
 */
export type ReplyPart =
  | { kind: 'markdown'; text: string }
  | { kind: 'ask'; spec: AskSpec }
  | { kind: 'ask-error'; reason: string; text: string };

/**
 * The outcome of reading one ask block: the spec, or the reason it is not one.
 *
 * A bare `null` was the earlier shape, and it is what let a malformed block sit
 * in the console indistinguishable from an intentional plain-text fallback. The
 * reason is the whole point — the renderer shows it, so the author of the block
 * sees the field they got wrong instead of a wall of their own JSON.
 */
export type AskParse = { ok: true; spec: AskSpec } | { ok: false; reason: string };

const fail = (reason: string): AskParse => ({ ok: false, reason });

/**
 * Field names that are wrong but plausible, mapped to the real one.
 *
 * Every entry here has actually been written by an agent composing a block from
 * memory instead of reading the schema. Naming the correct field turns a
 * rejection into an instruction; without it the author re-reads the same docs
 * that did not stop the mistake the first time.
 */
const MISTAKEN_KEYS: Record<string, string> = {
  question: 'title',
  value: 'label',
  description: 'detail',
};

/** `saw \`question\`, the field is \`title\`` — or empty when nothing is recognisable. */
function hint(present: Record<string, unknown>, correct: string): string {
  for (const [wrong, real] of Object.entries(MISTAKEN_KEYS)) {
    if (real === correct && wrong in present)
      return ` — saw \`${wrong}\`, the field is \`${correct}\``;
  }
  return '';
}

/**
 * Validate parsed JSON as an {@link AskSpec}.
 *
 * Every rejection carries a located reason ("question 2, option 1: ..."), and
 * never throws. A malformed block must never blank a reply — the text is the
 * thing the reader came for — but it must not pass silently either, so the
 * caller renders the reason alongside the original block.
 */
export function parseAskSpec(raw: string): AskParse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return fail(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('the block must be a JSON object with a `questions` array');
  }

  const questions = (value as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return fail('missing `questions` — it must be an array');
  if (questions.length === 0) return fail('`questions` is empty — ask at least one');

  const parsed: AskQuestion[] = [];
  for (const [qi, q] of questions.entries()) {
    const at = `question ${String(qi + 1)}`;
    if (typeof q !== 'object' || q === null || Array.isArray(q)) {
      return fail(`${at}: must be an object`);
    }
    const fields = q as Record<string, unknown>;
    const { title, evidence, chip, options, allowOwn, multi } = fields;
    if (typeof title !== 'string' || title.trim().length === 0) {
      return fail(`${at}: needs a non-empty \`title\`${hint(fields, 'title')}`);
    }
    if (!Array.isArray(options)) return fail(`${at}: needs an \`options\` array`);
    if (options.length === 0) return fail(`${at}: \`options\` is empty — offer at least one`);

    const parsedOptions: AskOption[] = [];
    for (const [oi, o] of options.entries()) {
      const oat = `${at}, option ${String(oi + 1)}`;
      if (typeof o !== 'object' || o === null || Array.isArray(o)) {
        return fail(`${oat}: must be an object`);
      }
      const optionFields = o as Record<string, unknown>;
      const { label, detail, recommended, why } = optionFields;
      if (typeof label !== 'string' || label.trim().length === 0) {
        return fail(`${oat}: needs a non-empty \`label\`${hint(optionFields, 'label')}`);
      }
      parsedOptions.push({
        label,
        ...(typeof detail === 'string' ? { detail } : {}),
        ...(recommended === true ? { recommended: true } : {}),
        ...(typeof why === 'string' ? { why } : {}),
      });
    }

    parsed.push({
      title,
      ...(typeof evidence === 'string' ? { evidence } : {}),
      ...(typeof chip === 'string' ? { chip } : {}),
      options: parsedOptions,
      ...(allowOwn === false ? { allowOwn: false } : {}),
      ...(multi === true ? { multi: true } : {}),
    });
  }

  return { ok: true, spec: { questions: parsed } };
}

/**
 * A fence line: its indent, its character (backtick or tilde), its length, and
 * whatever info string follows.
 *
 * Markdown lets a fence be any run of three or more backticks or tildes, and a
 * fence is closed only by the same character at the same length or longer.
 * That is what lets this file — and the docs that describe the format —
 * demonstrate an ask block inside a longer fence without the demonstration
 * being mistaken for a real one.
 */
const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/;

/**
 * Split a reply into prose and ask cards.
 *
 * Line-based rather than a single regex so an unterminated fence — a block
 * still streaming in, or one the agent truncated — degrades to prose instead of
 * swallowing the rest of the message. That is also why a block only becomes an
 * `ask-error` once its closing fence has arrived: until then it is not yet a
 * block, and reporting it would make every streaming question flash red.
 */
export function splitReply(content: string): ReplyPart[] {
  const lines = content.split('\n');
  const parts: ReplyPart[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    const text = prose.join('\n');
    if (text.trim().length > 0) parts.push({ kind: 'markdown', text });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const open = FENCE.exec(line);
    // Only an `ask` fence at the top level opens a card. Anything else is an
    // ordinary code block, and is copied through verbatim along with everything
    // it encloses — including an ask fence used as an example.
    if (open?.[3] !== 'ask') {
      if (open !== null) {
        const marker = open[2] ?? '';
        const char = marker[0] ?? '`';
        prose.push(line);
        // Skip to this block's own closing fence: same character, at least as
        // long. Unterminated, the rest of the reply is prose.
        i++;
        for (; i < lines.length; i++) {
          const inner = lines[i] ?? '';
          prose.push(inner);
          const close = FENCE.exec(inner);
          if (
            close !== null &&
            close[3] === '' &&
            (close[2] ?? '').startsWith(char) &&
            (close[2] ?? '').length >= marker.length
          ) {
            break;
          }
        }
        continue;
      }
      prose.push(line);
      continue;
    }

    const marker = open[2] ?? '```';
    const char = marker[0] ?? '`';

    // Collect to the closing fence. Without one, this was not a block.
    const body: string[] = [];
    let closeAt = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = FENCE.exec(lines[j] ?? '');
      if (
        candidate !== null &&
        candidate[3] === '' &&
        (candidate[2] ?? '').startsWith(char) &&
        (candidate[2] ?? '').length >= marker.length
      ) {
        closeAt = j;
        break;
      }
      body.push(lines[j] ?? '');
    }
    if (closeAt === -1) {
      prose.push(line);
      continue;
    }

    const close = lines[closeAt] ?? '```';
    const result = parseAskSpec(body.join('\n'));
    flushProse();
    if (result.ok) {
      parts.push({ kind: 'ask', spec: result.spec });
    } else {
      // The original block travels with the reason: the question is still
      // legible even when it is not clickable, and the reason says what to fix.
      parts.push({
        kind: 'ask-error',
        reason: result.reason,
        text: [line, ...body, close].join('\n'),
      });
    }
    i = closeAt;
  }

  flushProse();
  return parts;
}
