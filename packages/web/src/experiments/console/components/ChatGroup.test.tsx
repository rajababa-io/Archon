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

function userWith(files: Message['files']): MessageGroup {
  const group = assistant('see this', null);
  const [first] = group.messages;
  if (first === undefined) throw new Error('fixture has one message');
  return { ...group, role: 'user', messages: [{ ...first, role: 'user', files }] };
}

describe('ChatGroup attachments', () => {
  test('a kept image renders as a thumbnail that opens full size', () => {
    const url = '/api/attachments/0b61fe5f-0000-4000-8000-000000000000.png';
    const html = renderToStaticMarkup(
      <ChatGroup
        group={userWith([{ name: 'shot.png', mimeType: 'image/png', size: 9, imageUrl: url }])}
      />
    );
    expect(html).toContain(`<img src="${url}"`);
    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain('deleted from the server');
  });

  test('a file with nothing kept stays a chip, not a broken image', () => {
    const html = renderToStaticMarkup(
      <ChatGroup
        group={userWith([{ name: 'notes.md', mimeType: 'text/markdown', size: 9, imageUrl: null }])}
      />
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('notes.md');
    expect(html).toContain('deleted from the server');
  });
});

describe('ChatGroup thinking', () => {
  test('stored thinking folds to its first line, with no label, above the reply', () => {
    const html = renderToStaticMarkup(
      <ChatGroup
        group={assistant('PR 83 — CI red on lint.', 'cause — stale cache.\n\nfix — rerun.')}
      />
    );
    expect(html).toContain('cause — stale cache.');
    expect(html).not.toContain('fix — rerun.');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('italic');
    expect(html).not.toContain('Working notes');
    expect(html.indexOf('cause — stale cache.')).toBeLessThan(html.indexOf('PR 83'));
  });

  test('a reply still streaming shows its thinking open, with no fold', () => {
    const html = renderToStaticMarkup(
      <ChatGroup group={assistant('PR 83 —', 'cause — stale cache.\n\nfix — rerun.', 'live-0')} />
    );
    expect(html).toContain('fix — rerun.');
    expect(html.indexOf('cause — stale cache.')).toBeLessThan(html.indexOf('PR 83'));
    expect(html).not.toContain('aria-expanded');
  });

  test('a message with no thinking renders only the reply', () => {
    const html = renderToStaticMarkup(<ChatGroup group={assistant('Done.', null)} />);
    expect(html).toContain('Done.');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('text-small whitespace-pre-wrap text-text-tertiary');
  });

  test('blank streamed thinking renders nothing', () => {
    const html = renderToStaticMarkup(<ChatGroup group={assistant('PR 83 —', '  \n', 'live-0')} />);
    expect(html).toContain('PR 83');
    expect(html).not.toContain('text-small whitespace-pre-wrap text-text-tertiary');
  });
});
