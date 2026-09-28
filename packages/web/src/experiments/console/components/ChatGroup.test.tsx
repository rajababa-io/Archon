import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatGroup } from './ChatGroup';
import type { Message } from '../primitives/message';
import type { MessageGroup } from '../primitives/message-groups';

function assistant(content: string, thinking: string | null): MessageGroup {
  const message: Message = {
    id: 'm1',
    role: 'assistant',
    content,
    timestamp: '2026-09-28T00:00:00Z',
    toolCalls: [],
    error: null,
    category: null,
    dispatch: null,
    workflowResult: null,
    thinking,
    files: [],
    midTurn: false,
    usage: null,
  };
  return { key: 'm1', role: 'assistant', timestamp: message.timestamp, messages: [message] };
}

describe('ChatGroup thinking', () => {
  test('thinking is shown open, above the reply, with no label or toggle', () => {
    const html = renderToStaticMarkup(
      <ChatGroup
        group={assistant('PR 83 — CI red on lint.', 'cause — stale cache.\n\nfix — rerun.')}
      />
    );
    expect(html).toContain('cause — stale cache.\n\nfix — rerun.');
    expect(html.indexOf('cause — stale cache.')).toBeLessThan(html.indexOf('PR 83'));
    expect(html).not.toContain('Thinking');
    expect(html).not.toContain('aria-expanded');
  });

  test('a message with no thinking renders only the reply', () => {
    const html = renderToStaticMarkup(<ChatGroup group={assistant('Done.', null)} />);
    expect(html).toContain('Done.');
    expect(html).not.toContain('text-small whitespace-pre-wrap text-text-tertiary');
  });
});
