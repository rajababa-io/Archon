import { describe, expect, test } from 'bun:test';
import { splitReply, type AskOption, type AskQuestion } from '@archon/awaiting';
import type { MessageChunk } from '@archon/providers/types';
import { buildAskTool, withToolReplies } from './ask-tool';

function harness(): { tool: ReturnType<typeof buildAskTool>; emitted: string[] } {
  const emitted: string[] = [];
  return { tool: buildAskTool({ emit: t => emitted.push(t) }), emitted };
}

// `Required<>` makes this a compile error the day AskQuestion or AskOption
// gains a field, which is what holds the description's field list to the shape.
const EVERY_OPTION_FIELD: Required<AskOption> = {
  label: 'Ship it',
  detail: 'It is green.',
  recommended: true,
  why: 'Nothing is blocking.',
};
const EVERY_QUESTION_FIELD: Required<AskQuestion> = {
  title: 'Ship now?',
  evidence: 'CI passed at 14:10 UTC.',
  chip: 'PR 83',
  options: [EVERY_OPTION_FIELD, { label: 'Wait' }],
  allowOwn: false,
  multi: true,
};

describe('ask tool', () => {
  test('a valid call emits a fence that renders as the same card a hand-typed one would', async () => {
    const { tool, emitted } = harness();
    const out = await tool.handler({ questions: [EVERY_QUESTION_FIELD] });

    expect(out).toContain('1 question shown');
    expect(emitted).toHaveLength(1);
    const parts = splitReply(emitted[0] ?? '');
    expect(parts).toEqual([{ kind: 'ask', spec: { questions: [EVERY_QUESTION_FIELD] } }]);
  });

  // The acceptance case from #77: the misspelling that shipped as raw JSON.
  test.each([
    [
      'question for title',
      { question: 'Ship now?', options: [{ label: 'a' }] },
      'saw `question`, the field is `title`',
    ],
    [
      'description for detail',
      { title: 'Ship now?', options: [{ value: 'a', description: 'd' }] },
      'saw `value`, the field is `label`',
    ],
    ['no options', { title: 'Ship now?' }, 'needs an `options` array'],
  ])('rejects %s, naming the fix, and shows nothing', async (_name, question, expected) => {
    const { tool, emitted } = harness();
    const out = await tool.handler({ questions: [question] });
    expect(out).toContain('ask rejected — nothing was shown');
    expect(out).toContain(expected);
    expect(emitted).toEqual([]);
  });

  test('JSON text in place of the array is rejected rather than parsed', async () => {
    const { tool, emitted } = harness();
    const out = await tool.handler({
      questions: JSON.stringify([{ title: 't', options: [{ label: 'a' }] }]),
    });
    expect(out).toContain('ask rejected');
    expect(emitted).toEqual([]);
  });

  test('unknown keys are dropped from the emitted fence', async () => {
    const { tool, emitted } = harness();
    await tool.handler({ questions: [{ title: 't', options: [{ label: 'a', colour: 'red' }] }] });
    expect(emitted[0]).not.toContain('colour');
  });

  test('the description names every field the parser reads', () => {
    const { tool } = harness();
    for (const key of [...Object.keys(EVERY_QUESTION_FIELD), ...Object.keys(EVERY_OPTION_FIELD)]) {
      expect(tool.description).toContain(`\`${key}`);
    }
  });
});

describe('withToolReplies', () => {
  async function* stream(
    chunks: MessageChunk[],
    onYield: (i: number) => void
  ): AsyncGenerator<MessageChunk> {
    for (const [i, c] of chunks.entries()) {
      yield c;
      onYield(i);
    }
  }

  test('text queued while a tool ran is released just before the next chunk', async () => {
    const pending: string[] = [];
    const chunks: MessageChunk[] = [
      { type: 'assistant', content: 'Before.' },
      { type: 'tool', toolName: 'mcp__archon__ask', toolInput: {} },
      { type: 'tool_result', toolName: 'mcp__archon__ask', toolOutput: 'ok' },
    ];
    // The handler runs after the tool chunk is consumed, before the result arrives.
    const source = stream(chunks, i => {
      if (i === 1) pending.push('FENCE');
    });
    const out: MessageChunk[] = [];
    for await (const c of withToolReplies(source, pending)) out.push(c);
    expect(out.map(c => c.type)).toEqual(['assistant', 'tool', 'assistant', 'tool_result']);
    expect(out[2]).toEqual({ type: 'assistant', content: 'FENCE' });
  });

  test('text queued after the last chunk is still released', async () => {
    const pending: string[] = [];
    const source = stream([{ type: 'assistant', content: 'x' }], () => pending.push('LATE'));
    const out: MessageChunk[] = [];
    for await (const c of withToolReplies(source, pending)) out.push(c);
    expect(out.at(-1)).toEqual({ type: 'assistant', content: 'LATE' });
  });
});
