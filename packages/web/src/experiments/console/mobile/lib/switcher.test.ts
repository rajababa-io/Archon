import { describe, expect, test } from 'bun:test';
import { projectChatRows, projectRows, switcherGroups } from './switcher';
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
      projectId: null,
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
    expect(ids(switcherGroups(chats, statuses, new Set(), label))).toEqual([
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
    expect(ids(switcherGroups(chats, statuses, new Set(), label))).toEqual([
      ['b', ['y']],
      ['a', ['x']],
    ]);
  });

  test('equally urgent projects fall back to their names', () => {
    const chats = [
      found('y', 'b', '2026-09-01T00:00:00Z'),
      found('x', 'a', '2026-09-01T00:00:00Z'),
    ];
    expect(ids(switcherGroups(chats, new Map(), new Set(), label))).toEqual([
      ['a', ['x']],
      ['b', ['y']],
    ]);
  });

  // #5: unread is not a status, so it cannot outrank one — it leads its peers.
  test('an unread chat leads its status peers, and never jumps a more urgent status', () => {
    const chats = [
      found('new-idle', 'a', '2026-09-20T00:00:00Z'),
      found('old-unread', 'a', '2026-09-01T00:00:00Z'),
      found('working', 'a', '2026-08-01T00:00:00Z'),
    ];
    const statuses = new Map<string, ChatStatus>([['working', 'working']]);
    const rows = switcherGroups(chats, statuses, new Set(['old-unread']), label)[0]?.rows ?? [];
    expect(rows.map(r => [r.chat.id, r.unread])).toEqual([
      ['working', false],
      ['old-unread', true],
      ['new-idle', false],
    ]);
  });

  test('an unread chat breaks a tie between equally urgent projects', () => {
    const chats = [
      found('x', 'a', '2026-09-01T00:00:00Z'),
      found('y', 'b', '2026-09-01T00:00:00Z'),
    ];
    expect(ids(switcherGroups(chats, new Map(), new Set(['y']), label))).toEqual([
      ['b', ['y']],
      ['a', ['x']],
    ]);
  });

  test('closed chats are left out, and a project with only closed chats disappears', () => {
    const chats = [
      found('open', 'a', '2026-09-01T00:00:00Z'),
      found('closed', 'a', '2026-09-02T00:00:00Z', true),
      found('also-closed', 'b', '2026-09-02T00:00:00Z', true),
    ];
    expect(ids(switcherGroups(chats, new Map(), new Set(), label))).toEqual([['a', ['open']]]);
  });
});

describe('projectChatRows', () => {
  test("one project's open chats, the one that needs you first", () => {
    const chats = [
      found('old', 'a', '2026-09-28T09:00:00Z'),
      found('new', 'a', '2026-09-28T11:00:00Z'),
      found('asks', 'a', '2026-09-28T08:00:00Z'),
      found('closed', 'a', '2026-09-28T12:00:00Z', true),
      found('elsewhere', 'b', '2026-09-28T12:00:00Z'),
    ];
    const statuses = new Map<string, ChatStatus>([['asks', 'awaiting']]);
    expect(
      projectChatRows(chats, statuses, new Set(), 'a').map(r => [r.chat.id, r.status])
    ).toEqual([
      ['asks', 'awaiting'],
      ['new', 'idle'],
      ['old', 'idle'],
    ]);
  });
});

describe('projectRows', () => {
  test('names every registered project, one with no chats included, by label', () => {
    const chats = [
      found('b1', 'b', '2026-09-01T00:00:00Z'),
      found('b2', 'b', '2026-09-02T00:00:00Z'),
      found('b-closed', 'b', '2026-09-03T00:00:00Z', true),
      found('elsewhere', 'gone', '2026-09-03T00:00:00Z'),
    ];
    expect(projectRows(['b', 'quiet', 'a'], chats, label)).toEqual([
      { projectId: 'a', open: 0 },
      { projectId: 'b', open: 2 },
      { projectId: 'quiet', open: 0 },
    ]);
  });
});
