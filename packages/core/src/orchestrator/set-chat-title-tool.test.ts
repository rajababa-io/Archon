import { describe, expect, test } from 'bun:test';
import { buildSetChatTitleTool } from './set-chat-title-tool';

function harness(write?: (title: string) => Promise<void>): {
  tool: ReturnType<typeof buildSetChatTitleTool>;
  calls: string[];
} {
  const calls: string[] = [];
  const tool = buildSetChatTitleTool({
    conversationId: 'conv-1',
    write:
      write ??
      (async (title): Promise<void> => {
        calls.push(title);
      }),
  });
  return { tool, calls };
}

describe('set_chat_title', () => {
  test('writes the title, trimmed', async () => {
    const { tool, calls } = harness();
    const out = await tool.handler({ title: '  #96 Ask card: attach a file  ' });
    expect(calls).toEqual(['#96 Ask card: attach a file']);
    expect(out).toContain('#96 Ask card: attach a file');
  });

  test('refuses an empty or missing title without writing', async () => {
    const { tool, calls } = harness();
    expect(await tool.handler({ title: '   ' })).toContain('empty');
    expect(await tool.handler({})).toContain('empty');
    expect(await tool.handler({ title: 42 })).toContain('empty');
    expect(calls).toEqual([]);
  });

  test('caps the title to the column width', async () => {
    const { tool, calls } = harness();
    await tool.handler({ title: 'x'.repeat(300) });
    expect(calls[0]).toHaveLength(255);
  });

  test('returns the failure rather than throwing', async () => {
    // Provider adapters add no safety net — an uncaught throw surfaces into the
    // agent loop.
    const { tool } = harness(() => Promise.reject(new Error('db gone')));
    expect(await tool.handler({ title: '#1 x' })).toContain('db gone');
  });
});
