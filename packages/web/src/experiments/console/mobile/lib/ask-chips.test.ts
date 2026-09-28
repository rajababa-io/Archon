import { describe, expect, test } from 'bun:test';
import type { AskSpec } from '@archon/awaiting';
import { composeAnswer } from '../../primitives/ask';
import { toMessage, type Message } from '../../primitives/message';
import { answerOwn, confirmChips, openAsk, startChips, tapChip, type ChipStep } from './ask-chips';

const ONE: AskSpec = {
  questions: [{ title: 'Which width?', options: [{ label: 'Fixed' }, { label: 'Dragged' }] }],
};

const TWO: AskSpec = {
  questions: [
    { title: 'Which width?', options: [{ label: 'Fixed' }, { label: 'Dragged' }] },
    {
      title: 'Which panels?',
      multi: true,
      options: [{ label: 'Runs' }, { label: 'Files' }, { label: 'Changes' }],
    },
  ],
};

const fence = (spec: AskSpec): string => ['```ask', JSON.stringify(spec), '```'].join('\n');

let n = 0;
function message(role: 'user' | 'assistant' | 'system', content: string): Message {
  n += 1;
  return toMessage({
    id: `m${String(n)}`,
    role,
    content,
    metadata: '{}',
    created_at: '2026-09-28T10:00:00.000Z',
  });
}

function shown(step: ChipStep): Extract<ChipStep, { kind: 'show' }>['state'] {
  if (step.kind !== 'show') throw new Error(`expected show, got ${JSON.stringify(step)}`);
  return step.state;
}

describe('openAsk', () => {
  test("finds the ask block in the agent's last word", () => {
    expect(openAsk([message('user', 'hi'), message('assistant', `Pick:\n${fence(ONE)}`)])).toEqual(
      ONE
    );
  });

  test('your reply closes it', () => {
    expect(openAsk([message('assistant', fence(ONE)), message('user', 'Fixed')])).toBeNull();
  });

  test('a tool-call row with no text is not the last word', () => {
    expect(openAsk([message('assistant', fence(ONE)), message('assistant', '  ')])).toEqual(ONE);
  });

  test('a later reply without a question means nothing is asked', () => {
    expect(openAsk([message('assistant', fence(ONE)), message('assistant', 'Done.')])).toBeNull();
  });

  test('a malformed block is not answerable from chips', () => {
    expect(openAsk([message('assistant', '```ask\n{"nope": 1}\n```')])).toBeNull();
  });
});

describe('answering from chips', () => {
  test('one tap answers a one-question ask, exactly as the card would', () => {
    expect(tapChip(ONE, startChips(ONE), 'Dragged')).toEqual({
      kind: 'send',
      text: composeAnswer(ONE.questions, [['Dragged']]),
    });
  });

  test('a set moves to the next question, and a multi-answer one waits for confirm', () => {
    const second = shown(tapChip(TWO, startChips(TWO), 'Fixed'));
    expect(second.index).toBe(1);

    const one = shown(tapChip(TWO, second, 'Files'));
    const both = shown(tapChip(TWO, one, 'Runs'));
    const untoggled = shown(tapChip(TWO, both, 'Files'));
    expect(untoggled.answers[1]).toEqual(['Runs']);

    expect(confirmChips(TWO, untoggled)).toEqual({
      kind: 'send',
      text: composeAnswer(TWO.questions, [['Fixed'], ['Runs']]),
    });
  });

  test('confirm with nothing chosen stays put', () => {
    const second = shown(tapChip(TWO, startChips(TWO), 'Fixed'));
    expect(shown(confirmChips(TWO, second))).toEqual(second);
  });

  test('a skipped earlier question is shown again before sending', () => {
    const onSecond = { index: 1, answers: [null, null] };
    const back = shown(confirmChips(TWO, shown(tapChip(TWO, onSecond, 'Runs'))));
    expect(back.index).toBe(0);
  });

  test('"Other…" answers the question with your own words', () => {
    expect(answerOwn(ONE, startChips(ONE), 'Whatever the last drag was')).toEqual({
      kind: 'send',
      text: composeAnswer(ONE.questions, [['Whatever the last drag was']]),
    });
  });

  test('your own words sit beside the options chosen on a multi-answer question', () => {
    const second = shown(tapChip(TWO, startChips(TWO), 'Fixed'));
    const chosen = shown(tapChip(TWO, second, 'Runs'));
    expect(answerOwn(TWO, chosen, 'Logs')).toEqual({
      kind: 'send',
      text: composeAnswer(TWO.questions, [['Fixed'], ['Runs', 'Logs']]),
    });
  });
});
