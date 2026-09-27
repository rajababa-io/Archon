import { describe, expect, test } from 'bun:test';
import {
  askAwaitingIds,
  awaitingInputIds,
  chatStatus,
  completedIds,
  readyIds,
  unreadIds,
} from './chat-status';

const sets = (
  working: string[],
  awaiting: string[],
  done: string[] = [],
  unread: string[] = [],
  ready: string[] = [],
  waiting: string[] = []
) => ({
  working: new Set(working),
  awaiting: new Set(awaiting),
  done: new Set(done),
  unread: new Set(unread),
  ready: new Set(ready),
  waiting: new Set(waiting),
});

describe('chatStatus', () => {
  test('awaiting outranks working — the half that needs a human wins', () => {
    expect(chatStatus('a', sets(['a'], ['a']))).toBe('awaiting');
  });
  test('the seven states', () => {
    expect(chatStatus('a', sets(['a'], []))).toBe('working');
    expect(chatStatus('a', sets([], ['a']))).toBe('awaiting');
    expect(chatStatus('a', sets([], [], [], ['a']))).toBe('unread');
    expect(chatStatus('a', sets([], [], ['a']))).toBe('done');
    expect(chatStatus('a', sets([], [], [], [], ['a']))).toBe('ready');
    expect(chatStatus('a', sets([], [], [], [], [], ['a']))).toBe('waiting');
    expect(chatStatus('a', sets([], []))).toBe('idle');
  });

  // The state exists to stop idle saying "nothing is pending" while the server
  // is waiting on CI for the chat — and to replace idle only.
  test('waiting replaces idle and nothing else', () => {
    expect(chatStatus('a', sets(['a'], [], [], [], [], ['a']))).toBe('working');
    expect(chatStatus('a', sets([], ['a'], [], [], [], ['a']))).toBe('awaiting');
    expect(chatStatus('a', sets([], [], [], ['a'], [], ['a']))).toBe('unread');
    expect(chatStatus('a', sets([], [], ['a'], [], [], ['a']))).toBe('done');
    expect(chatStatus('a', sets([], [], [], [], ['a'], ['a']))).toBe('ready');
    expect(chatStatus('b', sets([], [], [], [], [], ['a']))).toBe('idle');
  });

  // The pair this state exists to separate. `done` is the human's answer and
  // `ready` is the agent asking for one, so a chat the server has been told is
  // finished must not still be asking. The server clears `ready` when a chat is
  // marked done, so this combination should not occur — the ordering is what
  // makes a stale row read as settled rather than as two contradictory claims.
  test('done outranks ready — the human answer settles the question', () => {
    expect(chatStatus('a', sets([], [], ['a'], [], ['a']))).toBe('done');
  });
  // The other side of it: waiting on a decision is something to act on, and
  // "nothing is pending" is not. Reporting it as idle is the gap the state
  // exists to close.
  test('ready outranks idle — a claim waiting on a decision is not nothing', () => {
    expect(chatStatus('a', sets([], [], [], [], ['a']))).toBe('ready');
  });
  // Ranked with `done`, for the same reason `done` is: a chat that has spoken
  // since you looked is worth reading before it is worth filing.
  test('unread outranks ready', () => {
    expect(chatStatus('a', sets([], [], [], ['a'], ['a']))).toBe('unread');
  });
  // Both live states are about right now, which outranks any claim about the
  // work as a whole — the rule `done` already follows.
  test('working and awaiting both outrank ready', () => {
    expect(chatStatus('a', sets(['a'], [], [], [], ['a']))).toBe('working');
    expect(chatStatus('a', sets([], ['a'], [], [], ['a']))).toBe('awaiting');
  });
  // A chat mid-sentence is unfinished, not missed. Amber on every turn in
  // flight is the noise that made the two previous attempts unusable.
  test('working outranks unread — a streaming reply has not been missed', () => {
    expect(chatStatus('a', sets(['a'], [], [], ['a']))).toBe('working');
  });
  test('awaiting outranks unread — the specific ask wins over the general one', () => {
    expect(chatStatus('a', sets([], ['a'], [], ['a']))).toBe('awaiting');
  });
  // The inverse of 'both live states outrank done': a chat you called finished
  // that has since spoken is worth looking at again, so unread beats green.
  test('unread outranks done', () => {
    expect(chatStatus('a', sets([], [], ['a'], ['a']))).toBe('unread');
  });
  // Green is a claim about the WORK; the other two are claims about right now,
  // and right now wins. A chat marked done that is asked another question has
  // to say so, or the mark is a lie for as long as the turn lasts.
  test('both live states outrank done', () => {
    expect(chatStatus('a', sets(['a'], [], ['a']))).toBe('working');
    expect(chatStatus('a', sets([], ['a'], ['a']))).toBe('awaiting');
  });
  test('done still outranks idle', () => {
    expect(chatStatus('a', sets([], [], ['a']))).toBe('done');
  });
});

describe('completedIds', () => {
  test('only the chats a human has marked', () => {
    expect([
      ...completedIds([
        { id: 'a', completed: true },
        { id: 'b', completed: false },
      ]),
    ]).toEqual(['a']);
  });
});

describe('readyIds', () => {
  test('only the chats the agent has declared finished', () => {
    expect([
      ...readyIds([
        { id: 'a', ready: true },
        { id: 'b', ready: false },
      ]),
    ]).toEqual(['a']);
  });

  // The guard that the two previous attempts at this signal failed. Nothing is
  // inferred from the shape of the conversation, so a rail full of chats whose
  // last word was the agent's produces an EMPTY set — which is what keeps
  // `idle` reachable.
  test('nothing is derived — a chat that has merely finished speaking is not ready', () => {
    expect([
      ...readyIds([
        { id: 'a', ready: false },
        { id: 'b', ready: false },
      ]),
    ]).toEqual([]);
  });
});

describe('awaitingInputIds', () => {
  test('paused is not enough — something has to be being asked', () => {
    expect([...awaitingInputIds([{ status: 'paused', conversationPlatformId: 'a' }])]).toEqual([]);
    expect([
      ...awaitingInputIds([
        { status: 'paused', approval: { message: 'ok?' }, conversationPlatformId: 'a' },
      ]),
    ]).toEqual(['a']);
  });
  test('a running run never counts, approval or not', () => {
    expect([
      ...awaitingInputIds([
        { status: 'running', approval: { message: 'x' }, conversationPlatformId: 'a' },
      ]),
    ]).toEqual([]);
  });
  test('a chat-dispatched run is found by its worker id — the feed has no other', () => {
    // The dashboard runs feed exposes a web run's conversation as
    // `worker_platform_id`; `conversationPlatformId` is absent there. Reading
    // only the latter is why this never fired.
    expect([
      ...awaitingInputIds([
        { status: 'paused', approval: { message: 'ok?' }, workerPlatformId: 'web-1' },
      ]),
    ]).toEqual(['web-1']);
  });

  test('an explicit conversation id still wins over the worker id', () => {
    expect([
      ...awaitingInputIds([
        {
          status: 'paused',
          approval: { message: 'ok?' },
          conversationPlatformId: 'cli-1',
          workerPlatformId: 'web-1',
        },
      ]),
    ]).toEqual(['cli-1']);
  });

  test('a run with no conversation is skipped rather than crashing', () => {
    expect([
      ...awaitingInputIds([
        { status: 'paused', approval: {}, conversationPlatformId: null },
        { status: 'paused', approval: {} },
      ]),
    ]).toEqual([]);
  });
});

describe('askAwaitingIds', () => {
  const ask = (body: string): string => ['```ask', body, '```'].join('\n');
  const spec = '{"questions":[{"title":"Ship it?","options":[{"label":"Yes"}]}]}';

  test('a chat whose last message is a question is your move', () => {
    expect([
      ...askAwaitingIds([{ id: 'a', askCandidate: `Here is the call:\n${ask(spec)}` }]),
    ]).toEqual(['a']);
  });

  test('no candidate, nothing to decide', () => {
    expect([...askAwaitingIds([{ id: 'a', askCandidate: null }])]).toEqual([]);
  });

  test('a question that failed to render is still a question', () => {
    // The agent stopped to ask either way, and a chat whose card is broken is
    // the one most in need of a human opening it. Dropping it from the rail
    // would hide the breakage a second time.
    expect([...askAwaitingIds([{ id: 'a', askCandidate: ask('{ not json') }])]).toEqual(['a']);
  });

  test('the parser decides, not the fence — an unterminated block is prose', () => {
    // The server sends anything containing the fence, deliberately. What counts
    // as a question is settled here, and half a block is not one yet.
    expect([...askAwaitingIds([{ id: 'a', askCandidate: '```ask\n{ not json' }])]).toEqual([]);
  });

  test('an ask block shown as an EXAMPLE inside a longer fence is not a question', () => {
    const quoted = ['````markdown', ask(spec), '````'].join('\n');
    expect([...askAwaitingIds([{ id: 'a', askCandidate: quoted }])]).toEqual([]);
  });
});

describe('chatStatus when the working signal is missing', () => {
  const none: ReadonlySet<string> = new Set();

  // The regression this replaced: a third set marked every chat whose last
  // word was the agent's as awaiting. Every finished chat ends that way, so
  // the rail went five-for-five amber — and because `working` is polled, a
  // chat being actively worked on announced that it needed a human for the
  // seconds after a reconnect.
  //
  // `unread` is that idea rebuilt around a stored read marker, so the guard
  // that matters now is a different one: membership has to be EARNED by the
  // comparison in `unreadIds`, and an empty set still falls to silence.
  test('the agent having spoken last is not a call for help', () => {
    expect(
      chatStatus('a', {
        working: none,
        awaiting: none,
        done: none,
        unread: none,
        ready: none,
        waiting: none,
      })
    ).toBe('idle');
  });

  test('an unknown answer falls to silence, never to amber', () => {
    expect(
      chatStatus('unheard-of', {
        working: none,
        awaiting: none,
        done: none,
        unread: none,
        ready: none,
        waiting: none,
      })
    ).toBe('idle');
  });

  // Amber, but not the same amber-by-default the old rule produced: this chat
  // is in the set because activity outran its read marker, and reading it
  // takes it back out. That is what makes idle reachable.
  test('unread is amber on its own, and is still not a call for help', () => {
    expect(
      chatStatus('a', {
        working: none,
        awaiting: none,
        done: none,
        unread: new Set(['a']),
        ready: none,
        waiting: none,
      })
    ).toBe('unread');
  });

  test('a gate still outranks working', () => {
    expect(
      chatStatus('a', {
        working: new Set(['a']),
        awaiting: new Set(['a']),
        done: none,
        unread: none,
        ready: none,
        waiting: none,
      })
    ).toBe('awaiting');
  });
});

describe('unreadIds', () => {
  const chat = (id: string, activity: string | null, read: string | null) => ({
    id,
    lastActivityAt: activity,
    lastReadAt: read,
  });

  test('activity after the read marker is unread', () => {
    expect([...unreadIds([chat('a', '2026-09-25T10:00:00Z', '2026-09-25T09:00:00Z')])]).toEqual([
      'a',
    ]);
  });

  test('reading clears it — this is the half the two previous attempts lacked', () => {
    expect([...unreadIds([chat('a', '2026-09-25T09:00:00Z', '2026-09-25T10:00:00Z')])]).toEqual([]);
  });

  test('read at exactly the activity instant is read, not unread', () => {
    const t = '2026-09-25T10:00:00Z';
    expect([...unreadIds([chat('a', t, t)])]).toEqual([]);
  });

  test('never read, but it has spoken — unread', () => {
    expect([...unreadIds([chat('a', '2026-09-25T10:00:00Z', null)])]).toEqual(['a']);
  });

  // A chat with nothing to be behind on cannot be behind. Without this, every
  // freshly created row would arrive amber.
  test('no activity is not unread, however the read marker reads', () => {
    expect([
      ...unreadIds([chat('a', null, null), chat('b', null, '2026-09-25T10:00:00Z')]),
    ]).toEqual([]);
  });

  // Same instant, different text. Comparing these as strings puts the offset
  // form BEFORE the Z form and silently reports the chat as read.
  test('compared as instants, not as strings — a differing offset still agrees', () => {
    expect([
      ...unreadIds([chat('a', '2026-09-25T10:00:00Z', '2026-09-25T03:00:00-07:00')]),
    ]).toEqual([]);
  });

  test('an unparseable timestamp does not throw, and does not invent a state', () => {
    expect([...unreadIds([chat('a', 'not-a-date', null)])]).toEqual([]);
    expect([...unreadIds([chat('b', '2026-09-25T10:00:00Z', 'not-a-date')])]).toEqual(['b']);
  });

  test('empty string reads as absent, not as the epoch', () => {
    expect([...unreadIds([chat('a', '', '')])]).toEqual([]);
  });
});
