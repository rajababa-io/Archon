import { describe, expect, test } from 'bun:test';
import { renderedMessages } from './rendered-messages';
import type { LiveSegment } from './live-text';
import type { Message } from './message';

const NOW = '2026-09-28T12:00:00.000Z';

function row(id: string, role: Message['role'], content: string): Message {
  return {
    id,
    role,
    content,
    timestamp: NOW,
    toolCalls: [],
    files: [],
    midTurn: false,
    error: null,
    category: null,
    dispatch: null,
    workflowResult: null,
    usage: null,
    thinking: null,
  };
}

const seg = (content: string): LiveSegment => ({ content, category: null, hasTools: false });

describe('renderedMessages', () => {
  test('stored rows pass through untouched when nothing is pending', () => {
    const stored = [row('1', 'user', 'hi'), row('2', 'assistant', 'hello')];
    expect(renderedMessages(stored, null, [], NOW)).toEqual(stored);
  });

  test('the echo sits after the stored rows and before the streamed reply', () => {
    const stored = [row('1', 'assistant', 'hello'), row('2', 'user', 'hi')];
    const out = renderedMessages(stored, { content: 'next', files: [] }, [seg('streaming…')], NOW);
    expect(out.map(m => [m.id, m.role, m.content])).toEqual([
      ['1', 'assistant', 'hello'],
      ['2', 'user', 'hi'],
      ['pending-user', 'user', 'next'],
      ['live-0', 'assistant', 'streaming…'],
    ]);
  });

  test('a streamed segment the database already holds is not previewed twice', () => {
    // The echo is not a stored row, so it must not move the turn boundary:
    // the stored reply after the last stored user row already covers seg one.
    const stored = [row('1', 'user', 'hi'), row('2', 'assistant', 'first part')];
    const out = renderedMessages(stored, null, [seg('first part'), seg('second part')], NOW);
    expect(out.map(m => m.content)).toEqual(['hi', 'first part', 'second part']);
  });

  test('the echo carries its attachments', () => {
    const files = [{ name: 'a.png', mimeType: 'image/png', size: 3 }];
    const out = renderedMessages([], { content: 'look', files }, [], NOW);
    expect(out[0]?.files).toEqual(files);
  });
});
