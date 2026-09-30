import { describe, expect, test } from 'bun:test';
import { chatStatusSets, type ChatStatus } from './chat-status';
import { alertText, badgeText, chatAlerts, chatNotifications, chatStatuses } from './tab-signal';

const m = (entries: Record<string, ChatStatus>): Map<string, ChatStatus> =>
  new Map(Object.entries(entries));

const ASK = '```ask\n{"questions":[{"id":"q1","question":"Pick one","options":["a","b"]}]}\n```';

function chat(
  id: string,
  over: Partial<{
    completed: boolean;
    ready: boolean;
    askCandidate: string | null;
    lastActivityAt: string | null;
    lastReadAt: string | null;
  }> = {}
): {
  id: string;
  completed: boolean;
  ready: boolean;
  askCandidate: string | null;
  lastActivityAt: string | null;
  lastReadAt: string | null;
} {
  return {
    id,
    completed: false,
    ready: false,
    askCandidate: null,
    lastActivityAt: '2026-09-27T10:00:00Z',
    lastReadAt: '2026-09-27T10:00:00Z',
    ...over,
  };
}

describe('chatStatuses', () => {
  test('uses the rail precedence for every chat', () => {
    const rows = [
      chat('work'),
      chat('gate'),
      chat('asked', { askCandidate: ASK }),
      chat('new', { lastReadAt: null }),
      chat('ci'),
      chat('run'),
      chat('quiet'),
    ];
    const got = chatStatuses(
      rows,
      chatStatusSets(rows, {
        working: new Set(['work', 'gate']),
        runAwaiting: new Set(['gate']),
        running: new Set(['run', 'gate']),
        waiting: new Set(['ci']),
      })
    );
    expect(Object.fromEntries(got)).toEqual({
      work: 'working',
      gate: 'awaiting',
      asked: 'awaiting',
      // #5: unread is the bold title, not a status.
      new: 'idle',
      ci: 'waiting',
      run: 'running',
      quiet: 'idle',
    });
  });
});

describe('chatNotifications', () => {
  const found = (id: string, at: string | null = '2026-09-27T10:00:00Z', projectId = 'p1') => ({
    chat: { id, title: `chat ${id}`, lastActivityAt: at, completed: false },
    projectId,
  });

  test('awaiting and unread — never working, ready or idle on their own', () => {
    const got = chatNotifications(
      ['a', 'b', 'c', 'd', 'e'].map(id => found(id)),
      m({ a: 'awaiting', b: 'idle', c: 'working', d: 'idle', e: 'ready' }),
      new Set(['b'])
    );
    expect(got.map(n => [n.id, n.kind])).toEqual([
      ['a', 'awaiting'],
      ['b', 'unread'],
    ]);
    expect(chatNotifications([], new Map(), new Set())).toEqual([]);
  });

  // Unread is a set beside the status (#5), so the two can overlap.
  test('a chat both awaiting and unread is one notification, and says awaiting', () => {
    const got = chatNotifications([found('a')], m({ a: 'awaiting' }), new Set(['a']));
    expect(got.map(n => [n.id, n.kind])).toEqual([['a', 'awaiting']]);
  });

  test('awaiting leads, then newest first; each carries its own project', () => {
    const got = chatNotifications(
      [
        found('old', '2026-09-27T08:00:00Z'),
        found('new', '2026-09-27T12:00:00Z', 'p2'),
        found('ask', '2026-09-27T07:00:00Z'),
      ],
      m({ old: 'idle', new: 'idle', ask: 'awaiting' }),
      new Set(['old', 'new'])
    );
    expect(got.map(n => n.id)).toEqual(['ask', 'new', 'old']);
    expect(got[1]?.projectId).toBe('p2');
  });

  // The whole of #289: a closed chat that moved after it was last read.
  test('a closed chat is not a notification, through the real status sets', () => {
    const rows = [
      chat('closed', { completed: true, lastReadAt: null }),
      chat('open', { lastReadAt: null }),
    ];
    const sets = chatStatusSets(rows, {
      working: new Set(),
      runAwaiting: new Set(),
      running: new Set(),
      waiting: new Set(),
    });
    const got = chatNotifications(
      rows.map(r => found(r.id)),
      chatStatuses(rows, sets),
      sets.unread
    );
    expect(got.map(n => n.id)).toEqual(['open']);
  });
});

describe('badgeText', () => {
  test('nothing at zero, the number to 99, 99+ past it', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(1)).toBe('1');
    expect(badgeText(12)).toBe('12');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
    expect(badgeText(420)).toBe('99+');
  });
});

describe('chatAlerts', () => {
  test('working to idle, done or ready is finished', () => {
    const got = chatAlerts(
      m({ a: 'working', b: 'working', c: 'working' }),
      m({ a: 'idle', b: 'done', c: 'ready' })
    );
    expect(got.map(x => x.kind)).toEqual(['finished', 'finished', 'finished']);
  });
  test('a turn that ends on a question is one alert, asking', () => {
    expect(chatAlerts(m({ a: 'working' }), m({ a: 'awaiting' }))).toEqual([
      { id: 'a', kind: 'asking' },
    ]);
  });
  test('a gate appearing on an idle chat is asking', () => {
    expect(chatAlerts(m({ a: 'idle' }), m({ a: 'awaiting' }))).toEqual([
      { id: 'a', kind: 'asking' },
    ]);
  });
  test('no alert for a chat seen for the first time — page load is not news', () => {
    expect(chatAlerts(new Map(), m({ a: 'awaiting', b: 'idle' }))).toEqual([]);
  });
  test('no alert when nothing changed, or on starting to work, or on being read', () => {
    expect(chatAlerts(m({ a: 'awaiting', b: 'idle' }), m({ a: 'awaiting', b: 'working' }))).toEqual(
      []
    );
  });
});

describe('alertText', () => {
  test('names the chat and nothing else', () => {
    expect(alertText('finished', 'Fix login')).toEqual({
      title: 'Chat finished',
      body: 'Fix login',
    });
    expect(alertText('asking', 'Fix login')).toEqual({
      title: 'Waiting on you',
      body: 'Fix login',
    });
  });
  test('an untitled chat still says something', () => {
    expect(alertText('finished', null).body).toBe('Untitled chat');
    expect(alertText('finished', '  ').body).toBe('Untitled chat');
  });
});
