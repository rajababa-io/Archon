import { describe, expect, test } from 'bun:test';
import {
  askAwaitingIds,
  awaitingInputIds,
  chatStatus,
  chatStatusSets,
  completedIds,
  markUnreadBlocker,
  readyIds,
  runningRunIds,
  unreadIds,
} from './chat-status';

const sets = (
  working: string[],
  awaiting: string[],
  done: string[] = [],
  unread: string[] = [],
  ready: string[] = [],
  waiting: string[] = [],
  running: string[] = []
) => ({
  working: new Set(working),
  awaiting: new Set(awaiting),
  done: new Set(done),
  unread: new Set(unread),
  ready: new Set(ready),
  waiting: new Set(waiting),
  running: new Set(running),
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

  // #209: a chat that calls watch_ci nearly always ends its turn with a reply,
  // so under unread the state was almost never seen. It outranks unread, done
  // and running; the live states and ready still outrank it.
  test('waiting outranks unread, done and running, and nothing above them', () => {
    expect(chatStatus('a', sets(['a'], [], [], [], [], ['a']))).toBe('working');
    expect(chatStatus('a', sets([], ['a'], [], [], [], ['a']))).toBe('awaiting');
    expect(chatStatus('a', sets([], [], [], ['a'], [], ['a']))).toBe('waiting');
    expect(chatStatus('a', sets([], [], ['a'], [], [], ['a']))).toBe('waiting');
    expect(chatStatus('a', sets([], [], [], [], [], ['a'], ['a']))).toBe('waiting');
    expect(chatStatus('a', sets([], [], [], [], ['a'], ['a']))).toBe('ready');
    expect(chatStatus('b', sets([], [], [], [], [], ['a']))).toBe('idle');
  });

  // #188: a chat whose run executed for twenty minutes read "Nothing is running
  // in this chat". Running takes idle's place and nothing else's.
  test('a running run replaces idle, and nothing that outranks it', () => {
    expect(chatStatus('a', sets([], [], [], [], [], [], ['a']))).toBe('running');
    expect(chatStatus('a', sets(['a'], [], [], [], [], [], ['a']))).toBe('working');
    expect(chatStatus('a', sets([], ['a'], [], [], [], [], ['a']))).toBe('awaiting');
    expect(chatStatus('a', sets([], [], [], ['a'], [], [], ['a']))).toBe('unread');
    expect(chatStatus('a', sets([], [], ['a'], [], [], [], ['a']))).toBe('done');
    expect(chatStatus('a', sets([], [], [], [], ['a'], [], ['a']))).toBe('ready');
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
  // The agent claiming its work landed is the new thing to read, and the
  // decision it asks for is why the chat is worth opening (#181).
  test('ready outranks unread', () => {
    expect(chatStatus('a', sets([], [], [], ['a'], ['a']))).toBe('ready');
  });
  // `ready` jumps unread without dragging `done` over unread with it: a closed
  // chat that has since spoken still shows unread, and done still settles ready.
  test('done beats ready even when unread, and unread still beats done alone', () => {
    expect(chatStatus('a', sets([], [], ['a'], ['a'], ['a']))).toBe('unread');
    expect(chatStatus('a', sets([], [], ['a'], [], ['a']))).toBe('done');
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

describe('runningRunIds', () => {
  test('only a run that is moving counts — paused, finished and failed do not', () => {
    const runs = ['running', 'paused', 'completed', 'failed', 'cancelled'].map(status => ({
      status,
      conversationPlatformId: status,
    }));
    expect([...runningRunIds(runs)]).toEqual(['running']);
  });

  test('a chat-dispatched run is found by its worker id, as awaiting finds it', () => {
    expect([...runningRunIds([{ status: 'running', workerPlatformId: 'web-1' }])]).toEqual([
      'web-1',
    ]);
  });

  test('a run with no conversation marks no chat', () => {
    expect([...runningRunIds([{ status: 'running' }])]).toEqual([]);
  });
});

describe('askAwaitingIds', () => {
  const ask = (body: string): string => ['```ask', body, '```'].join('\n');
  const spec = '{"questions":[{"title":"Ship it?","options":[{"label":"Yes"}]}]}';

  test('a chat whose last message is a question is your move', () => {
    expect([
      ...askAwaitingIds([
        { id: 'a', completed: false, askCandidate: `Here is the call:\n${ask(spec)}` },
      ]),
    ]).toEqual(['a']);
  });

  test('no candidate, nothing to decide', () => {
    expect([...askAwaitingIds([{ id: 'a', completed: false, askCandidate: null }])]).toEqual([]);
  });

  test('a question that failed to render is still a question', () => {
    // The agent stopped to ask either way, and a chat whose card is broken is
    // the one most in need of a human opening it. Dropping it from the rail
    // would hide the breakage a second time.
    expect([
      ...askAwaitingIds([{ id: 'a', completed: false, askCandidate: ask('{ not json') }]),
    ]).toEqual(['a']);
  });

  test('the parser decides, not the fence — an unterminated block is prose', () => {
    // The server sends anything containing the fence, deliberately. What counts
    // as a question is settled here, and half a block is not one yet.
    expect([
      ...askAwaitingIds([{ id: 'a', completed: false, askCandidate: '```ask\n{ not json' }]),
    ]).toEqual([]);
  });

  test('an ask block shown as an EXAMPLE inside a longer fence is not a question', () => {
    const quoted = ['````markdown', ask(spec), '````'].join('\n');
    expect([...askAwaitingIds([{ id: 'a', completed: false, askCandidate: quoted }])]).toEqual([]);
  });

  test('a chat marked done is not asking, even when it ended on a question', () => {
    // The Open tab hides done chats, so counting one put the project header on
    // "Needs you" with no amber chat anywhere to explain it (#197).
    expect([
      ...askAwaitingIds([
        { id: 'open', completed: false, askCandidate: ask(spec) },
        { id: 'done', completed: true, askCandidate: ask(spec) },
      ]),
    ]).toEqual(['open']);
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
        running: none,
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
        running: none,
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
        running: none,
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
        running: none,
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

describe('markUnreadBlocker', () => {
  test('an idle chat you are not reading may be marked', () => {
    expect(markUnreadBlocker('idle', false, true)).toBeNull();
  });

  test('every other status is refused, each with its own reason', () => {
    const others = [
      'working',
      'awaiting',
      'unread',
      'done',
      'ready',
      'running',
      'waiting',
    ] as const;
    const reasons = others.map(s => markUnreadBlocker(s, false, true));
    for (const r of reasons) expect(r).not.toBeNull();
    expect(new Set(reasons).size).toBe(others.length);
  });

  test('the open chat is refused even when idle — the page would clear it at once', () => {
    expect(markUnreadBlocker('idle', true, true)).toBe("You're reading it");
  });

  test('a chat with no activity is refused — the mark could not show', () => {
    expect(markUnreadBlocker('idle', false, false)).toBe('Nothing to read yet');
  });
});

describe('chatStatusSets', () => {
  const ASK = '```ask\n{"questions":[{"id":"q1","question":"Pick one","options":["a","b"]}]}\n```';
  const row = (id: string, over: { ready?: boolean; askCandidate?: string | null } = {}) => ({
    id,
    completed: false,
    ready: over.ready ?? false,
    askCandidate: over.askCandidate ?? null,
    lastActivityAt: '2026-09-27T10:00:00Z',
    lastReadAt: '2026-09-27T10:00:00Z',
  });
  const none = new Set<string>();
  const live = { working: none, runAwaiting: none, running: none, waiting: none };

  test('an unanswered question outranks the agent saying it is ready (#217)', () => {
    // The exact case that split the bar from the dot: `ready` set, and an ask
    // block still unanswered. Built here, it is awaiting for every reader.
    const rows = [row('a', { ready: true, askCandidate: ASK })];
    expect(chatStatus('a', chatStatusSets(rows, live))).toBe('awaiting');
  });

  test('merges a run paused on a gate into awaiting', () => {
    const rows = [row('a', { ready: true })];
    const sets = chatStatusSets(rows, { ...live, runAwaiting: new Set(['a']) });
    expect(chatStatus('a', sets)).toBe('awaiting');
    expect(chatStatus('a', chatStatusSets(rows, live))).toBe('ready');
  });
});
