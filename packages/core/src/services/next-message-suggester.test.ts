import { mock, describe, test, expect, beforeEach, type Mock } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import type { MessageChunk, SendQueryOptions } from '@archon/providers/types';

// ─── Mock setup (BEFORE importing module under test) ─────────────────────────

mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
}));

type SendQuery = (
  prompt: string,
  cwd: string,
  resumeSessionId?: string,
  options?: SendQueryOptions
) => AsyncGenerator<MessageChunk>;

const mockSendQuery = mock(async function* (): AsyncGenerator<MessageChunk> {
  yield { type: 'assistant', content: 'run the tests' };
  yield { type: 'result', cost: 0.0004 };
}) as Mock<SendQuery>;

mock.module('@archon/providers', () => ({
  getAgentProvider: mock(() => ({ sendQuery: mockSendQuery, getType: () => 'claude' })),
  getRegisteredProviders: mock(() => []),
  PI_PROVIDER_ENV_VARS: { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' },
  PI_AMBIENT_VENDORS: ['amazon-bedrock', 'google-vertex'],
}));

// ─── Import module under test (AFTER all mocks) ─────────────────────────────

import {
  buildSuggestionPrompt,
  cleanSuggestion,
  suggestNextMessage,
} from './next-message-suggester';

describe('cleanSuggestion', () => {
  test('keeps one short line, unquoted', () => {
    expect(cleanSuggestion('"run the tests"\nbecause they changed')).toBe('run the tests');
  });

  test('NONE, blank and over-long answers offer nothing', () => {
    expect(cleanSuggestion('NONE')).toBeNull();
    expect(cleanSuggestion('   ')).toBeNull();
    expect(cleanSuggestion('x'.repeat(200))).toBeNull();
  });
});

describe('buildSuggestionPrompt', () => {
  test('keeps the end of a long reply, where the next step is usually said', () => {
    const reply = `${'a'.repeat(10_000)} — next: open the PR`;
    const prompt = buildSuggestionPrompt('fix the bug', reply);
    expect(prompt).toContain('next: open the PR');
    expect(prompt.length).toBeLessThan(6000);
  });
});

describe('suggestNextMessage', () => {
  beforeEach(() => {
    mockSendQuery.mockClear();
  });

  test('returns the suggestion and what it cost, with no tools and no session', async () => {
    const result = await suggestNextMessage('claude', '/repo', 'fix it', 'Fixed the bug.', {
      model: 'haiku',
    });
    expect(result).toEqual({ text: 'run the tests', costUsd: 0.0004 });
    const [, , resume, options] = mockSendQuery.mock.calls[0] ?? [];
    expect(resume).toBeUndefined();
    expect(options?.model).toBe('haiku');
    expect(options?.nodeConfig?.allowed_tools).toEqual([]);
    expect(options?.abortSignal).toBeDefined();
  });

  test('a provider failure yields nothing instead of throwing', async () => {
    mockSendQuery.mockImplementationOnce(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'assistant', content: 'partial' };
      throw new Error('rate limited');
    });
    expect(await suggestNextMessage('claude', '/repo', 'fix it', 'Done.', {})).toBeNull();
  });

  test('an empty reply is not worth a model call', async () => {
    expect(await suggestNextMessage('claude', '/repo', 'fix it', '  ', {})).toBeNull();
    expect(mockSendQuery).not.toHaveBeenCalled();
  });
});
