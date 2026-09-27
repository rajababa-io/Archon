import { describe, expect, it } from 'bun:test';
import { acceptsSuggestion, suggestionToShow } from './next-suggestion';

const key = (
  k: string,
  mods: Partial<Record<'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey', boolean>> = {}
) => ({
  key: k,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  ...mods,
});

describe('suggestionToShow', () => {
  const s = { text: 'run the tests' };

  it('shows in an empty box', () => {
    expect(suggestionToShow(s, '', null)).toBe('run the tests');
  });

  it('hides as soon as anything is typed', () => {
    expect(suggestionToShow(s, 'r', null)).toBeNull();
  });

  it('stays gone once dismissed, even after the box is cleared again', () => {
    expect(suggestionToShow(s, '', 'run the tests')).toBeNull();
  });

  it('a newer suggestion shows even after an older one was dismissed', () => {
    expect(suggestionToShow({ text: 'open the PR' }, '', 'run the tests')).toBe('open the PR');
  });

  it('shows nothing when there is no suggestion', () => {
    expect(suggestionToShow(null, '', null)).toBeNull();
  });
});

describe('acceptsSuggestion', () => {
  it('takes Tab and Right arrow', () => {
    expect(acceptsSuggestion(key('Tab'))).toBe(true);
    expect(acceptsSuggestion(key('ArrowRight'))).toBe(true);
  });

  it('leaves Shift+Tab and modified keys alone, and never takes Enter', () => {
    expect(acceptsSuggestion(key('Tab', { shiftKey: true }))).toBe(false);
    expect(acceptsSuggestion(key('ArrowRight', { metaKey: true }))).toBe(false);
    expect(acceptsSuggestion(key('Enter'))).toBe(false);
  });
});
