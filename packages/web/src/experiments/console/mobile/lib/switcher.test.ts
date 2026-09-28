import { describe, expect, test } from 'bun:test';
import { switcherGroups } from './switcher';
import type { ChatStatus } from '../../primitives/chat-status';
import type { FoundChat } from '../../skills/conversations';

function found(
  id: string,
  projectId: string,
  lastActivityAt: string,
  completed = false
): FoundChat {
  return {
    projectId,
    chat: {
      id,
      dbId: `db-${id}`,
      title: id,
      platformType: 'web',
      lastActivityAt,
      color: null,
      assistant: 'claude',
      completed,
      askCandidate: null,
      sortOrder: null,
      lastReadAt: null,
      ready: false,
    },
  };
}

const labels: Record<string, string> = { a: 'alpha', b: 'beta' };
const label = (id: string): string => labels[id] ?? id;

function ids(groups: ReturnType<typeof switcherGroups>): [string, string[]][] {
  return groups.map(g => [g.projectId, g.rows.map(r => r.chat.id)]);
}

describe('switcherGroups', () => {
  test('within a project: the chat that needs you first, then newest activity', () => {
    const chats = [
      found('old-idle', 'a', '2026-09-01T00:00:00Z'),
      found('new-idle', 'a', '2026-09-20T00:00:00Z'),
      found('asking', 'a', '2026-08-01T00:00:00Z'),
      found('working', 'a', '2026-09-10T00:00:00Z'),
    ];
    const statuses = new Map<string, ChatStatus>([
      ['old-idle', 'idle'],
      ['new-idle', 'idle'],
      ['asking', 'awaiting'],
      ['working', 'working'],
    ]);
    expect(ids(switcherGroups(chats, statuses, label))).toEqual([
      ['a', ['asking', 'working', 'new-idle', 'old-idle']],
    ]);
  });

  test('a project with a chat waiting on you sorts above one alphabetically earlier', () => {
    const chats = [
      found('x', 'a', '2026-09-01T00:00:00Z'),
      found('y', 'b', '2026-09-01T00:00:00Z'),
    ];
    const statuses = new Map<string, ChatStatus>([
      ['x', 'idle'],
      ['y', 'awaiting'],
    ]);
    expect(ids(switcherGroups(chats, statuses, label))).toEqual([
      ['b', ['y']],
      ['a', ['x']],
    ]);
  });

  test('equally urgent projects fall back to their names', () => {
    const chats = [
      found('y', 'b', '2026-09-01T00:00:00Z'),
      found('x', 'a', '2026-09-01T00:00:00Z'),
    ];
    expect(ids(switcherGroups(chats, new Map(), label))).toEqual([
      ['a', ['x']],
      ['b', ['y']],
    ]);
  });

  test('closed chats are left out, and a project with only closed chats disappears', () => {
    const chats = [
      found('open', 'a', '2026-09-01T00:00:00Z'),
      found('closed', 'a', '2026-09-02T00:00:00Z', true),
      found('also-closed', 'b', '2026-09-02T00:00:00Z', true),
    ];
    expect(ids(switcherGroups(chats, new Map(), label))).toEqual([['a', ['open']]]);
  });
});
