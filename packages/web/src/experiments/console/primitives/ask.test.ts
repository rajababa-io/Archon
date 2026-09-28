import { describe, test, expect } from 'bun:test';
import type { AskQuestion } from '@archon/awaiting';
import { composeAnswer, isComplete, toggleChoice, setCustomAnswer } from './ask';

describe('composeAnswer', () => {
  const questions: AskQuestion[] = [
    { title: 'First?', options: [{ label: 'a' }] },
    { title: 'Second?', options: [{ label: 'b' }] },
  ];

  test('numbers the answers in the order asked', () => {
    expect(composeAnswer(questions, [['Yes'], ['No']])).toBe(
      '1. First?\n   Yes\n2. Second?\n   No'
    );
  });

  test('marks an unanswered question rather than dropping it', () => {
    expect(composeAnswer(questions, [['Yes'], null])).toContain('(skipped)');
  });

  test('writes several choices one per line, so a comma in an option cannot be read as a separator', () => {
    const multi: AskQuestion[] = [
      {
        title: 'Which apply?',
        multi: true,
        options: [{ label: 'a, with a comma' }, { label: 'b' }],
      },
    ];
    expect(composeAnswer(multi, [['a, with a comma', 'b']])).toBe(
      '1. Which apply?\n   a, with a comma\n   b'
    );
  });
});

describe('isComplete', () => {
  const questions: AskQuestion[] = [
    { title: 'First?', options: [{ label: 'a' }] },
    { title: 'Second?', options: [{ label: 'b' }] },
  ];

  test('true only when every question has a non-blank answer', () => {
    expect(isComplete(questions, [['a'], ['b']])).toBe(true);
    expect(isComplete(questions, [['a'], null])).toBe(false);
    expect(isComplete(questions, [['a'], ['   ']])).toBe(false);
    expect(isComplete(questions, [['a'], []])).toBe(false);
    expect(isComplete(questions, [])).toBe(false);
  });
});

describe('toggleChoice', () => {
  test('a single-answer question replaces whatever was there', () => {
    expect(toggleChoice(null, 'a', false)).toEqual(['a']);
    expect(toggleChoice(['a'], 'b', false)).toEqual(['b']);
    // Re-picking the same option leaves it picked rather than clearing it —
    // a question that demands an answer should never be emptied by a click.
    expect(toggleChoice(['a'], 'a', false)).toEqual(['a']);
  });

  test('a multi-answer question adds, and removes on a second click', () => {
    expect(toggleChoice(null, 'a', true)).toEqual(['a']);
    expect(toggleChoice(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleChoice(['a', 'b'], 'a', true)).toEqual(['b']);
    expect(toggleChoice(['a'], 'a', true)).toEqual([]);
  });

  test('keeps the order options were chosen in', () => {
    expect(toggleChoice(['c', 'a'], 'b', true)).toEqual(['c', 'a', 'b']);
  });
});

describe('setCustomAnswer', () => {
  const options = [{ label: 'a' }, { label: 'b' }];

  test('a single-answer question is replaced outright', () => {
    expect(setCustomAnswer(null, 'typed', options, false)).toEqual(['typed']);
    expect(setCustomAnswer(['old'], 'new', options, false)).toEqual(['new']);
  });

  // The bug this exists to prevent: toggling left both, the card displayed the
  // stale one, and composeAnswer submitted the pair.
  test('editing free text replaces the old text, it does not add to it', () => {
    expect(setCustomAnswer(['old'], 'new', options, true)).toEqual(['new']);
  });

  test('chosen options survive alongside the custom text, in order', () => {
    expect(setCustomAnswer(['a', 'old', 'b'], 'new', options, true)).toEqual(['a', 'b', 'new']);
  });

  test('clearing the text leaves the chosen options behind', () => {
    expect(setCustomAnswer(['a', 'old'], '', options, true)).toEqual(['a']);
  });
});
