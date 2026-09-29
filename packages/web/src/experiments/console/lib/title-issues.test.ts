import { describe, expect, test } from 'bun:test';
import { titleParts } from './title-issues';

const numbers = (title: string): number[] =>
  titleParts(title).flatMap(p => (p.kind === 'issue' ? [p.number] : []));

describe('titleParts', () => {
  test('one leading number', () => {
    expect(titleParts('#96 Ask card: attach a file')).toEqual([
      { kind: 'issue', text: '#96', number: 96 },
      { kind: 'text', text: ' ' },
      { kind: 'text', text: 'Ask card: attach a file' },
    ]);
  });

  test('each of several leading numbers is its own issue', () => {
    expect(numbers('#97 #98 Deploy wait + log')).toEqual([97, 98]);
    expect(numbers('#99 #100 #101 Console polish')).toEqual([99, 100, 101]);
  });

  test('the +N form: the number links, the count does not', () => {
    const parts = titleParts('#99 +3 Console polish');
    expect(parts.filter(p => p.kind === 'issue').map(p => p.text)).toEqual(['#99']);
    expect(parts.filter(p => p.kind === 'more').map(p => p.text)).toEqual(['+3']);
  });

  test('a # further into the title is not an issue', () => {
    expect(numbers('Fix the #3 regression')).toEqual([]);
    expect(numbers('#5 Fix the #3 regression')).toEqual([5]);
    // Nothing after the count is a number either.
    expect(numbers('#1 +2 #3 later')).toEqual([1]);
  });

  test('a title with no numbers is one plain part', () => {
    expect(titleParts('Ask card: attach a file')).toEqual([
      { kind: 'text', text: 'Ask card: attach a file' },
    ]);
  });

  test('a number glued to a word, a zero, or a bare +N is not an issue', () => {
    expect(numbers('#96abc title')).toEqual([]);
    expect(numbers('#0 title')).toEqual([]);
    expect(titleParts('+3 title').some(p => p.kind === 'more')).toBe(false);
  });

  test('a title that is only a number', () => {
    expect(numbers('#7')).toEqual([7]);
  });

  test('the parts always join back to the title exactly', () => {
    for (const t of ['#96 A', '#97  #98\tB', '#99 +3 C', 'plain', '#1', '', '#1 +2 #3 x']) {
      expect(
        titleParts(t)
          .map(p => p.text)
          .join('')
      ).toBe(t);
    }
  });
});
