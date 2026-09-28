import { describe, expect, test } from 'bun:test';
import { resolveChatMode } from './notify';

type Own = 'muted' | 'following';
const prefs = (
  over: { mutedProjects?: string[]; conversations?: Record<string, Own> } = {}
): { mutedProjects: string[]; conversations: Record<string, Own> } => ({
  mutedProjects: [],
  conversations: {},
  ...over,
});

describe('resolveChatMode', () => {
  test('nothing set is default', () => {
    expect(resolveChatMode(prefs(), 'web-1', 'p1')).toBe('default');
  });

  test('a muted project silences its chats', () => {
    expect(resolveChatMode(prefs({ mutedProjects: ['p1'] }), 'web-1', 'p1')).toBe('muted');
    expect(resolveChatMode(prefs({ mutedProjects: ['p1'] }), 'web-2', 'p2')).toBe('default');
  });

  test("a chat's own mode beats its project's mute", () => {
    const p = prefs({ mutedProjects: ['p1'], conversations: { 'web-1': 'following' } });
    expect(resolveChatMode(p, 'web-1', 'p1')).toBe('following');
  });

  test('a run with no chat still answers to its project', () => {
    expect(resolveChatMode(prefs({ mutedProjects: ['p1'] }), null, 'p1')).toBe('muted');
    expect(resolveChatMode(prefs(), null, null)).toBe('default');
  });
});
