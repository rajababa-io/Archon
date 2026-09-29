/**
 * The deploy destroys whatever the container is holding, so these tests are
 * about one direction of failure: this must never report a drained server that
 * is not one. A wrong "still holding" costs a wait; a wrong "drained" costs
 * somebody's turn.
 *
 * The cases that do not exist in `turn-gap.test.ts` are the interesting ones —
 * a missing drain block, and a `state` that disagrees with the counts it was
 * derived from.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import {
  clampDrainBudget,
  readDrain,
  settingsFromEnv,
  waitForDrain,
  DRAIN_WAIT_DEFAULTS,
  DRAIN_HELD_NOTHING,
  DRAIN_TIMED_OUT,
  DRAIN_UNREADABLE,
  DRAIN_NOT_IN_EFFECT,
  parkAnswerLines,
  resumeReport,
} from './drain-wait';
import { MAX_DRAIN_BUDGET_SECONDS } from '../packages/server/src/routes/drain-budget';

/** The shape `/api/health` returns while draining, taken from the route that builds it. */
const draining = {
  status: 'ok',
  drain: {
    requestedAt: '2026-09-25T02:00:00.000Z',
    expiresAt: '2026-09-25T02:30:00.000Z',
    refusedCount: 2,
    state: 'draining',
    holding: { activeConversations: 2, queuedMessages: 0, runningWorkflows: 1 },
  },
};

const drained = {
  status: 'ok',
  drain: {
    requestedAt: '2026-09-25T02:00:00.000Z',
    expiresAt: '2026-09-25T02:30:00.000Z',
    refusedCount: 5,
    state: 'drained',
    holding: { activeConversations: 0, queuedMessages: 0, runningWorkflows: 0 },
  },
};

/** A healthy server that is not draining at all. The block is simply absent. */
const notDraining = { status: 'ok', concurrency: { active: 3 }, runningWorkflows: 0 };

describe('readDrain', () => {
  test('a server holding nothing is a server that may be replaced', () => {
    expect(readDrain(drained)).toEqual({ state: 'drained' });
  });

  test('what it is still holding is named, so a waiting operator can see why', () => {
    expect(readDrain(draining)).toEqual({
      state: 'draining',
      holding: '2 chats mid-turn, 1 workflow run executing',
    });
  });

  test('counts are singular when they are one, because the line is read by people', () => {
    expect(
      readDrain({
        drain: {
          ...draining.drain,
          holding: { activeConversations: 1, queuedMessages: 1, runningWorkflows: 1 },
        },
      })
    ).toEqual({
      state: 'draining',
      holding: '1 chat mid-turn, 1 message queued, 1 workflow run executing',
    });
  });

  test('no drain block is the drain being gone, never a quiet box', () => {
    // The whole reason this is its own state: absence means the drain this deploy
    // armed has lapsed or been cancelled, so the server is admitting work again.
    expect(readDrain(notDraining)).toEqual({ state: 'absent' });
  });

  test('a state that disagrees with its own counts is unreadable, not drained', () => {
    expect(() =>
      readDrain({
        drain: {
          ...drained.drain,
          state: 'drained',
          holding: { activeConversations: 1, queuedMessages: 0, runningWorkflows: 0 },
        },
      })
    ).toThrow(/drained while still holding 1 chat mid-turn/);
  });

  test('draining while holding nothing is equally a disagreement', () => {
    expect(() =>
      readDrain({
        drain: {
          ...draining.drain,
          holding: { activeConversations: 0, queuedMessages: 0, runningWorkflows: 0 },
        },
      })
    ).toThrow(/draining while holding nothing/);
  });

  test('a missing count is an error rather than a zero', () => {
    expect(() =>
      readDrain({ drain: { ...draining.drain, holding: { activeConversations: 0 } } })
    ).toThrow(/drain\.holding\.queuedMessages/);
  });

  test('a state word this deploy does not know stops it', () => {
    expect(() => readDrain({ drain: { ...drained.drain, state: 'mostly' } })).toThrow(/mostly/);
  });

  test('a body that is not an object at all stops it', () => {
    expect(() => readDrain('ok')).toThrow(/no usable body/);
  });
});

describe('clampDrainBudget', () => {
  test('a budget the endpoint accepts is passed through untouched', () => {
    expect(clampDrainBudget(900)).toBe(900);
  });

  test('a budget above the endpoint maximum is clamped to it, not refused', () => {
    // Arming is what installs the cancel trap, so discovering the refusal after
    // the POST would be discovering it too late.
    expect(clampDrainBudget(MAX_DRAIN_BUDGET_SECONDS + 1)).toBe(MAX_DRAIN_BUDGET_SECONDS);
    expect(clampDrainBudget(999_999)).toBe(MAX_DRAIN_BUDGET_SECONDS);
  });

  test('the maximum itself is allowed', () => {
    expect(clampDrainBudget(MAX_DRAIN_BUDGET_SECONDS)).toBe(MAX_DRAIN_BUDGET_SECONDS);
  });

  test('a fractional budget becomes whole seconds the endpoint can parse', () => {
    expect(clampDrainBudget(12.9)).toBe(12);
  });

  test('a budget that is not a positive number stops the deploy', () => {
    expect(() => clampDrainBudget(0)).toThrow(/positive number of seconds/);
    expect(() => clampDrainBudget(-5)).toThrow(/positive number of seconds/);
    expect(() => clampDrainBudget(Number.NaN)).toThrow(/positive number of seconds/);
  });
});

describe('settingsFromEnv', () => {
  test('an empty environment is the defaults', () => {
    expect(settingsFromEnv({})).toEqual(DRAIN_WAIT_DEFAULTS);
  });

  test('the deploy script tunes it without arguments', () => {
    expect(
      settingsFromEnv({
        HEALTH_URL: 'http://app:4000/api/health',
        DRAIN_WAIT_TIMEOUT: '60',
        DRAIN_WAIT_INTERVAL: '1',
      })
    ).toEqual({
      healthUrl: 'http://app:4000/api/health',
      timeoutSeconds: 60,
      intervalSeconds: 1,
    });
  });

  test('an empty override is the default, because the shell passes empty strings', () => {
    expect(settingsFromEnv({ DRAIN_WAIT_INTERVAL: '' }).intervalSeconds).toBe(
      DRAIN_WAIT_DEFAULTS.intervalSeconds
    );
  });

  test('a nonsense timeout stops the deploy rather than silently defaulting', () => {
    expect(() => settingsFromEnv({ DRAIN_WAIT_TIMEOUT: 'soon' })).toThrow(/DRAIN_WAIT_TIMEOUT/);
  });
});

describe('waitForDrain', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /**
   * `typeof fetch` carries statics (Bun adds `preconnect`) that a bare handler
   * cannot satisfy, so the substitution is made once here rather than per call site.
   */
  function installFetch(handler: () => Promise<Response>): void {
    globalThis.fetch = handler as unknown as typeof fetch;
  }

  /** Answers each call with the next payload, repeating the last one forever. */
  function serve(payloads: readonly unknown[]): () => number {
    let calls = 0;
    installFetch(() => {
      const payload = payloads[Math.min(calls, payloads.length - 1)];
      calls++;
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    });
    return () => calls;
  }

  const fast = { ...DRAIN_WAIT_DEFAULTS, timeoutSeconds: 1, intervalSeconds: 0 };
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
  };

  test('one drained reading is the go-ahead — there is no next turn to race', async () => {
    // Deliberately unlike turn-gap.ts, which needs a confirming second read.
    // Nothing new is admitted under drain, so the count only ever falls.
    const calls = serve([drained]);
    expect(await waitForDrain(fast, log)).toBe(DRAIN_HELD_NOTHING);
    expect(calls()).toBe(1);
  });

  test('it waits out what the server is still holding', async () => {
    serve([draining, draining, drained]);
    expect(await waitForDrain(fast, log)).toBe(DRAIN_HELD_NOTHING);
  });

  test('a server that never finishes times out instead of swapping anyway', async () => {
    serve([draining]);
    expect(await waitForDrain({ ...fast, timeoutSeconds: 0 }, log)).toBe(DRAIN_TIMED_OUT);
  });

  test('a drain that has gone away is its own failure, not a timeout', async () => {
    serve([draining, notDraining]);
    expect(await waitForDrain(fast, log)).toBe(DRAIN_NOT_IN_EFFECT);
  });

  test('a health endpoint that cannot be reached stops the deploy', async () => {
    installFetch(() => Promise.reject(new Error('connection refused')));
    expect(await waitForDrain(fast, log)).toBe(DRAIN_UNREADABLE);
  });

  test('a 503 from health is unreadable, not drained', async () => {
    installFetch(() => Promise.resolve(new Response('unavailable', { status: 503 })));
    expect(await waitForDrain(fast, log)).toBe(DRAIN_UNREADABLE);
  });

  test('it reports what it is holding once, not once per poll', async () => {
    lines.length = 0;
    serve([draining, draining, draining, drained]);
    expect(await waitForDrain(fast, log)).toBe(DRAIN_HELD_NOTHING);
    expect(lines.filter(line => line.startsWith('draining:'))).toEqual([
      'draining: 2 chats mid-turn, 1 workflow run executing',
    ]);
    expect(lines.at(-1)).toBe('drained — the server is holding nothing');
  });
});

describe('parkAnswerLines', () => {
  const answer = {
    drainId: '0b7c7f43-6a4e-4c1b-9d59-3f6f2d1c8a10',
    parked: { chats: 3, queuedMessages: 1, runs: 1 },
    blocked: [
      { kind: 'chat', id: 'slack-thread-9', reason: 'platform_cannot_resume' },
      { kind: 'run', id: 'cli-run-1', reason: 'not_owned_by_this_server' },
    ],
  };

  test('the drain id comes first, alone, then the lines for the deploy log', () => {
    expect(parkAnswerLines(answer)).toEqual([
      '0b7c7f43-6a4e-4c1b-9d59-3f6f2d1c8a10',
      'parked 3 chats, 1 queued message, 1 workflow run',
      'still running, waiting for it: chat slack-thread-9 — its chat platform has no way to resume it after the restart',
      'still running, waiting for it: run cli-run-1 — this server does not run it',
    ]);
  });

  test('a drain id that is not a UUID is refused, because it becomes part of a URL', () => {
    expect(() => parkAnswerLines({ ...answer, drainId: '../drain' })).toThrow('drainId');
  });

  test('a missing count is an error, never a zero', () => {
    expect(() => parkAnswerLines({ ...answer, parked: { chats: 3, queuedMessages: 1 } })).toThrow(
      'parked.runs'
    );
  });

  test('a reason from a newer server is shown as it came', () => {
    const [, , line] = parkAnswerLines({
      ...answer,
      blocked: [{ kind: 'run', id: 'r', reason: 'something_new' }],
    });
    expect(line).toBe('still running, waiting for it: run r — something_new');
  });
});

describe('resumeReport', () => {
  const parked = { chats: 3, queuedMessages: 1, runs: 1 };

  test('complete once everything parked has resumed', () => {
    expect(resumeReport({ parked, resumed: parked })).toEqual({
      line: 'parked 3 chats, 1 queued message, 1 workflow run; resumed 3 chats, 1 queued message, 1 workflow run',
      complete: true,
    });
  });

  test('incomplete while anything is still waiting to come back', () => {
    expect(
      resumeReport({ parked, resumed: { chats: 3, queuedMessages: 0, runs: 1 } }).complete
    ).toBe(false);
  });
});
