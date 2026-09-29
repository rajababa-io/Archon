import { describe, expect, test } from 'bun:test';
import { EMPTY_SELECTION, selectRange, toggleChat } from './chat-selection';

const rows = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
const ids = (s: { ids: ReadonlySet<string> }): string[] => [...s.ids].sort();

describe('toggleChat', () => {
  test('adds, then removes, and moves the anchor each time', () => {
    const one = toggleChat(EMPTY_SELECTION, 'b');
    expect(ids(one)).toEqual(['b']);
    expect(one.anchor).toBe('b');
    const two = toggleChat(one, 'd');
    expect(ids(two)).toEqual(['b', 'd']);
    const back = toggleChat(two, 'b');
    expect(ids(back)).toEqual(['d']);
    expect(back.anchor).toBe('b');
  });
});

describe('selectRange', () => {
  test('selects the run from the anchor to the click, either direction', () => {
    const anchored = toggleChat(EMPTY_SELECTION, 'b');
    expect(ids(selectRange(anchored, rows, 'd', null))).toEqual(['b', 'c', 'd']);
    const up = toggleChat(EMPTY_SELECTION, 'd');
    expect(ids(selectRange(up, rows, 'a', null))).toEqual(['a', 'b', 'c', 'd']);
  });

  test('replaces the selection rather than adding to it, and keeps the anchor', () => {
    const first = selectRange(toggleChat(EMPTY_SELECTION, 'b'), rows, 'e', null);
    const second = selectRange(first, rows, 'c', null);
    expect(ids(second)).toEqual(['b', 'c']);
    expect(second.anchor).toBe('b');
  });

  test('with nothing selected, measures from the open chat', () => {
    expect(ids(selectRange(EMPTY_SELECTION, rows, 'c', 'a'))).toEqual(['a', 'b', 'c']);
  });

  test('with no anchor and no open chat, selects only the chat clicked', () => {
    const s = selectRange(EMPTY_SELECTION, rows, 'c', null);
    expect(ids(s)).toEqual(['c']);
    expect(s.anchor).toBe('c');
  });

  test('an anchor that has left the list starts over from the click', () => {
    const stale = { ids: new Set(['gone']), anchor: 'gone' };
    expect(ids(selectRange(stale, rows, 'b', null))).toEqual(['b']);
  });
});
