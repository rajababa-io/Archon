import { formatAskFence, validateAskSpec } from '@archon/awaiting';
import { createLogger } from '@archon/paths';
import {
  defineNativeToolInputSchema,
  type MessageChunk,
  type NativeTool,
} from '@archon/providers/types';

const log = createLogger('orchestrator.ask');

export interface AskToolContext {
  /**
   * Put text into the reply, where the agent's own text goes. The orchestrator
   * queues it and releases it into the provider stream as an assistant chunk
   * (see {@link withToolReplies}), so it takes the same path as anything the
   * agent typed.
   */
  emit: (text: string) => void;
}

const INPUT_SCHEMA = defineNativeToolInputSchema({
  properties: {
    questions: {
      kind: 'array',
      description:
        'The questions, in the order they should be answered. Pass the array itself, not JSON text.',
    },
  },
  required: ['questions'],
});

/**
 * Lets a chat ask its multiple-choice questions through a typed call instead of
 * a fence typed from memory (#77).
 *
 * The fence is an invented wire format: a tag that must read exactly `ask`, a
 * JSON body whose keys must be exactly `title` / `options` / `label`. Written by
 * hand it went wrong in ways no instruction fixed — a `json` tag, `question` for
 * `title` — and each mistake reached the reader as a dead code block. Here the
 * spec is checked before anything is shown, and a rejection goes back to the
 * agent, which is the one party that can correct it.
 *
 * WHY THE TOOL EMITS A FENCE RATHER THAN A NEW SHAPE: the fence is the
 * degradation story (a client that cannot draw cards still shows every option)
 * and `parseAskSpec` is the one renderer. A second, tool-only shape would mean
 * two formats every reader must understand. So the tool is a validator in front
 * of the existing format, and the hand-written fence keeps working beside it.
 *
 * WHY THE SCHEMA IS NOT RESTATED: `questions` is declared only as an array, and
 * {@link validateAskSpec} — the same function the console renders with — does
 * the rest. The description lists the fields for the model to read; the test
 * beside this file holds that list to the full `AskSpec` shape.
 *
 * Answering is unchanged: the card composes an ordinary message. No state is
 * written here.
 */
export function buildAskTool(ctx: AskToolContext): NativeTool {
  return {
    name: 'ask',
    description:
      'Ask the human one or more multiple-choice questions, shown as clickable cards. Use this instead of writing an ```ask block by hand: the questions are checked before anything is shown, and a wrong or missing field comes back to you as an error naming the right one. Call this BEFORE you write your reply: text written before any tool call does not reach the reader, pictures included. After it returns, write the whole reply — statements and pictures — then end your turn to wait; the cards are drawn after your reply, and the answer arrives as an ordinary message. Do not repeat the questions in text. Each question is an object: `title` (required, the question), `options` (required, at least one; each has `label` (required), optional `detail`, `recommended: true` on at most one option, and `why` for the recommended one), optional `evidence` (a paragraph shown above the question), optional `chip` (a short label for its subject), optional `allowOwn` (false hides the free-text answer), optional `multi` (true allows choosing several).',
    inputSchema: INPUT_SCHEMA,
    handler: (input): Promise<string> => {
      const result = validateAskSpec({ questions: input.questions });
      if (!result.ok) {
        log.info({ reason: result.reason }, 'ask.rejected');
        return Promise.resolve(
          `ask rejected — nothing was shown: ${result.reason}. Correct it and call ask again.`
        );
      }
      // Blank lines on both sides: batch mode joins chunks with no seam, and a
      // fence only opens and closes at the start of its own line.
      ctx.emit(`\n\n${formatAskFence(result.spec)}\n\n`);
      const count = result.spec.questions.length;
      log.info({ questions: count }, 'ask.shown');
      return Promise.resolve(
        `ask: ${String(count)} question${count === 1 ? '' : 's'} shown as cards; they are drawn after your reply. Now write the whole reply, pictures included, then end your turn; the answer arrives as the next message.`
      );
    },
  };
}

/**
 * Release text a tool queued into the provider stream as assistant chunks.
 *
 * A native tool's handler runs inside the provider, between the chunk that
 * announced the call and the one carrying its result, so anything it queued is
 * waiting by the time the next chunk arrives and is yielded just before it.
 * Downstream — the command check, the Stop-hook hold, the platform send, the
 * persisted row — it is indistinguishable from text the agent wrote itself,
 * which is the point: nothing past this line needs to know about the tool.
 */
const toolReplyChunks = new WeakSet<MessageChunk>();

/** True for a chunk {@link withToolReplies} released from a tool's queue. */
export function isToolReply(chunk: MessageChunk): boolean {
  return toolReplyChunks.has(chunk);
}

export async function* withToolReplies(
  stream: AsyncIterable<MessageChunk>,
  pending: string[]
): AsyncGenerator<MessageChunk> {
  const release = function* (): Generator<MessageChunk> {
    while (pending.length > 0) {
      const content = pending.shift();
      if (content !== undefined) {
        const chunk: MessageChunk = { type: 'assistant', content };
        toolReplyChunks.add(chunk);
        yield chunk;
      }
    }
  };
  for await (const chunk of stream) {
    yield* release();
    yield chunk;
  }
  yield* release();
}
