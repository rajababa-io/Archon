import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatGroup } from './ChatGroup';
import type { Message } from '../primitives/message';
import type { MessageGroup } from '../primitives/message-groups';

function assistant(content: string, thinking: string | null, id = 'm1'): MessageGroup {
  const message: Message = {
    id,
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

describe('ChatGroup working notes', () => {
  test('a stored reply folds its notes into a closed Working notes chip', () => {
    const html = renderToStaticMarkup(
      <ChatGroup
        group={assistant('PR 83 — CI red on lint.', 'cause — stale cache.\n\nfix — rerun.')}
      />
    );
    expect(html).toContain('Working notes');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('cause — stale cache.');
    expect(html.indexOf('Working notes')).toBeLessThan(html.indexOf('PR 83'));
  });

  test('a reply still streaming shows its notes open, with no chip', () => {
    const html = renderToStaticMarkup(
      <ChatGroup group={assistant('PR 83 —', 'cause — stale cache.', 'live-0')} />
    );
    expect(html).toContain('cause — stale cache.');
    expect(html.indexOf('cause — stale cache.')).toBeLessThan(html.indexOf('PR 83'));
    expect(html).not.toContain('Working notes');
    expect(html).not.toContain('aria-expanded');
  });

  test('a message with no notes renders only the reply', () => {
    const html = renderToStaticMarkup(<ChatGroup group={assistant('Done.', null)} />);
    expect(html).toContain('Done.');
    expect(html).not.toContain('Working notes');
    expect(html).not.toContain('text-small whitespace-pre-wrap text-text-tertiary');
  });
});
