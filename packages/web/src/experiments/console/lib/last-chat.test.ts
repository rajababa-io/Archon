import { describe, test, expect } from 'bun:test';
import { chooseNeighbourChat, chooseOpenChat, lastChatKey } from './last-chat';

const list = (...ids: string[]) => ids.map(id => ({ id }));

describe('lastChatKey', () => {
  test('is scoped per project', () => {
    expect(lastChatKey('a')).not.toBe(lastChatKey('b'));
    expect(lastChatKey('a')).toStartWith('archon.console.');
  });
});

describe('chooseOpenChat', () => {
  test('reopens the remembered chat', () => {
    expect(chooseOpenChat('older', list('newest', 'older'))).toBe('older');
  });

  test('falls back to the most recent when nothing is remembered', () => {
    expect(chooseOpenChat(null, list('newest', 'older'))).toBe('newest');
  });

  test('a remembered chat that no longer exists does not win', () => {
    // Archived or deleted since — opening nothing would look like a broken page.
    expect(chooseOpenChat('gone', list('newest', 'older'))).toBe('newest');
  });

  test('the fallback passes over filed chats, so landing does not unfold a folder', () => {
    const rows = [
      { id: 'parked', folder: 'Van' },
      { id: 'loose', folder: null },
    ];
    expect(chooseOpenChat(null, rows)).toBe('loose');
    // Remembered still wins: that is the chat you were reading.
    expect(chooseOpenChat('parked', rows)).toBe('parked');
    // Every chat filed: open one anyway rather than nothing.
    expect(chooseOpenChat(null, [{ id: 'parked', folder: 'Van' }])).toBe('parked');
  });

  test('an empty project opens nothing', () => {
    expect(chooseOpenChat('gone', [])).toBeNull();
    expect(chooseOpenChat(null, [])).toBeNull();
  });
});

describe('chooseNeighbourChat', () => {
  test('takes the chat below the one leaving', () => {
    expect(chooseNeighbourChat(list('a', 'b', 'c'), 'b', ['b'])).toBe('c');
  });

  test('falls back upwards at the bottom of the rail', () => {
    expect(chooseNeighbourChat(list('a', 'b', 'c'), 'c', ['c'])).toBe('b');
  });

  test('skips the other chats going with it', () => {
    // Bulk archive: b, c and d all leave, so the neighbour is e.
    expect(chooseNeighbourChat(list('a', 'b', 'c', 'd', 'e'), 'b', ['b', 'c', 'd'])).toBe('e');
  });

  test('skips upwards past the others too', () => {
    expect(chooseNeighbourChat(list('a', 'b', 'c'), 'c', ['b', 'c'])).toBe('a');
  });

  test('the last chat in the rail leaves nothing to open', () => {
    expect(chooseNeighbourChat(list('a'), 'a', ['a'])).toBeNull();
  });

  test('a chat that is not displayed has no neighbour', () => {
    expect(chooseNeighbourChat(list('a', 'b'), 'hidden', ['hidden'])).toBeNull();
  });
});
