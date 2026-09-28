import { describe, expect, test } from 'bun:test';
import type { ConversationSummary } from '../../primitives/conversation';
import { SAVED_CHAT_LIMIT, withSaved, type SavedChat } from './saved-chats';

const chat = (id: string, savedAt: number): SavedChat => ({
  found: { chat: { id } as ConversationSummary, projectId: 'p1' },
  projectLabel: 'project',
  messages: [],
  savedAt,
});
const ids = (list: readonly SavedChat[]): string[] => list.map(c => c.found.chat.id);

describe('withSaved', () => {
  test('the chat just read goes first', () => {
    expect(ids(withSaved([chat('a', 1), chat('b', 0)], chat('c', 2)))).toEqual(['c', 'a', 'b']);
  });

  test('reading a saved chat again replaces its copy and moves it up', () => {
    const next = withSaved([chat('a', 2), chat('b', 1)], chat('b', 3));
    expect(ids(next)).toEqual(['b', 'a']);
    expect(next[0]?.savedAt).toBe(3);
  });

  test('past the limit, the chat read longest ago is dropped', () => {
    const full = Array.from({ length: SAVED_CHAT_LIMIT }, (_, i) =>
      chat(`c${String(i)}`, SAVED_CHAT_LIMIT - i)
    );
    const next = withSaved(full, chat('new', 100));
    expect(next).toHaveLength(SAVED_CHAT_LIMIT);
    expect(ids(next)[0]).toBe('new');
    expect(ids(next)).not.toContain(`c${String(SAVED_CHAT_LIMIT - 1)}`);
  });
});
