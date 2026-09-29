import { describe, expect, test } from 'bun:test';
import { chatStatusSets, type ChatStatus } from './chat-status';
import { alertText, badgeText, chatAlerts, chatStatuses, wantingCount } from './tab-signal';

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

describe('wantingCount', () => {
  test('counts awaiting and unread — never working, done or ready on their own', () => {
    expect(
      wantingCount(
        m({ a: 'awaiting', b: 'idle', c: 'working', d: 'done', e: 'ready' }),
        new Set(['b'])
      )
    ).toBe(2);
    expect(wantingCount(new Map(), new Set())).toBe(0);
  });
  // Unread is a set beside the status now (#5), so the two can overlap.
  test('a chat both awaiting and unread counts once', () => {
    expect(wantingCount(m({ a: 'awaiting' }), new Set(['a']))).toBe(1);
  });
  test('an unread chat counts whatever its status', () => {
    expect(wantingCount(m({ a: 'done', b: 'ready' }), new Set(['a', 'b']))).toBe(2);
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
