import { describe, expect, test } from 'bun:test';
import { insertWord, quoteInto, withCommand } from './compose-text';

describe('insertWord', () => {
  test('into an empty box', () => {
    expect(insertWord('', 0, 0, '@src/a.ts')).toEqual({ value: '@src/a.ts ', caret: 10 });
  });

  test('spaced away from the word before it', () => {
    expect(insertWord('look at', 7, 7, '@a.ts')).toEqual({ value: 'look at @a.ts ', caret: 14 });
  });

  test('in the middle, without doubling the space that follows', () => {
    expect(insertWord('see  please', 4, 4, '@a.ts')).toEqual({
      value: 'see @a.ts please',
      caret: 9,
    });
  });

  test('replaces the selection', () => {
    expect(insertWord('fix THIS now', 4, 8, '@a.ts')).toEqual({
      value: 'fix @a.ts now',
      caret: 9,
    });
  });
});

describe('quoteInto', () => {
  test('quotes every line and leaves a line to answer on', () => {
    expect(quoteInto('', 'one\n\ntwo\n')).toEqual({
      value: '> one\n>\n> two\n\n',
      caret: 15,
    });
  });

  test('goes below what is already typed', () => {
    expect(quoteInto('my draft\n', 'said').value).toBe('my draft\n\n> said\n\n');
  });
});

describe('withCommand', () => {
  test('goes in front of what was typed, which becomes its argument', () => {
    expect(withCommand('  fix the bug', '/workflow run fix ')).toEqual({
      value: '/workflow run fix fix the bug',
      caret: 18,
    });
  });

  test('replaces a command already there', () => {
    expect(withCommand('/help me', '/status')).toEqual({ value: '/status', caret: 7 });
  });
});
