import { describe, expect, test } from 'bun:test';
import { groupChatsByStatus } from './chat-groups';
import type { ChatStatus } from './chat-status';
import type { ConversationSummary } from './conversation';

const chat = (id: string, lastActivityAt: string | null = null): ConversationSummary => ({
  id,
  dbId: `db-${id}`,
  title: id,
  platformType: 'web',
  lastActivityAt,
  color: null,
  assistant: 'claude',
  completed: false,
  askCandidate: null,
  sortOrder: null,
  lastReadAt: null,
  ready: false,
  projectId: 'p1',
});

const statuses =
  (map: Record<string, ChatStatus>) =>
  (id: string): ChatStatus =>
    map[id] ?? 'idle';

describe('groupChatsByStatus', () => {
  test('orders groups by urgency and drops empty ones', () => {
    const groups = groupChatsByStatus(
      [chat('idle'), chat('ready'), chat('ask'), chat('busy')],
      statuses({ ready: 'ready', ask: 'awaiting', busy: 'working' })
    );
    expect(groups.map(g => g.label)).toEqual(['Needs you', 'Working', 'Ready to close', 'Idle']);
    expect(groups.map(g => g.chats.map(c => c.id))).toEqual([
      ['ask'],
      ['busy'],
      ['ready'],
      ['idle'],
    ]);
  });

  test('CI waits and running workflows are working', () => {
    const groups = groupChatsByStatus(
      [chat('ci'), chat('wf')],
      statuses({ ci: 'waiting', wf: 'running' })
    );
    expect(groups.map(g => [g.key, g.chats.map(c => c.id)])).toEqual([['working', ['ci', 'wf']]]);
  });

  test('a closed chat gets its own group, not Idle', () => {
    const groups = groupChatsByStatus([chat('d')], statuses({ d: 'done' }));
    expect(groups.map(g => g.label)).toEqual(['Closed']);
  });

  test('newest first inside a group, with no activity last', () => {
    const groups = groupChatsByStatus(
      [chat('old', '2026-09-01T00:00:00Z'), chat('never'), chat('new', '2026-09-02T00:00:00Z')],
      statuses({})
    );
    expect(groups[0]?.chats.map(c => c.id)).toEqual(['new', 'old', 'never']);
  });
});
