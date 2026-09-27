import { describe, expect, mock, test } from 'bun:test';
import {
  ConversationLockManager,
  DeployParkAbort,
  DRAIN_REFUSAL_NOTICE,
  notifyDrainRefusal,
} from './conversation-lock';

/**
 * Nothing in this file sleeps. `acquireLock` resolves with the acquisition
 * status, not with handler completion, so the handlers report their own starts
 * into a log and the test decides when each one finishes. Waiting is always
 * "drain microtasks until the manager reached this state", and ordering is
 * asserted against the log rather than assumed from a wall-clock margin.
 */

interface GatedHandler {
  /** Lets the handler finish. */
  release: () => void;
  handler: () => Promise<void>;
}

/**
 * A handler the test drives explicitly: it appends its label to `log` when it
 * starts and stays in flight until released. `fail` makes it reject on release,
 * which exercises the manager's error path without a timing assumption.
 */
function gate(log: string[], label: string, { fail = false } = {}): GatedHandler {
  let release!: () => void;
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    release,
    handler: async () => {
      log.push(label);
      await released;
      if (fail) throw new Error(`handler ${label} failed`);
    },
  };
}

/**
 * The manager releases a lock and hands off to the next queued message entirely
 * on the microtask queue, so draining microtasks converges without touching the
 * clock. The bound turns a broken handoff into an immediate failure rather than
 * a hang.
 */
async function drainUntil(predicate: () => boolean, expectation: string): Promise<void> {
  for (let tick = 0; tick < 100; tick++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`manager never reached expected state: ${expectation}`);
}

/**
 * Waits for one more handler to start, whichever one the manager picked. The
 * caller then asserts the log, so picking the wrong one fails on the ordering
 * assertion instead of blocking on a handler that never runs.
 */
function drainUntilStarted(log: string[], count: number): Promise<void> {
  return drainUntil(() => log.length >= count, `${count} handler(s) started, saw [${log}]`);
}

/** Waits for the manager to have no active conversations and nothing queued. */
function drainUntilIdle(manager: ConversationLockManager): Promise<void> {
  return drainUntil(() => {
    const stats = manager.getStats();
    return stats.active === 0 && stats.queuedTotal === 0;
  }, 'idle (no active conversations, empty queues)');
}

describe('ConversationLockManager', () => {
  test('initializes with correct maxConcurrent', () => {
    const manager = new ConversationLockManager(5);
    const stats = manager.getStats();
    expect(stats.maxConcurrent).toBe(5);
    expect(stats.active).toBe(0);
    expect(stats.queuedTotal).toBe(0);
  });

  test('getStats returns empty state initially', () => {
    const manager = new ConversationLockManager(10);
    const stats = manager.getStats();
    expect(stats).toEqual({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    });
  });

  test('processes handler immediately when under capacity', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const only = gate(log, 'only');

    const result = await manager.acquireLock('test-1', only.handler);
    await drainUntilStarted(log, 1);

    expect(result.status).toBe('started');
    expect(log).toEqual(['only']);
    expect(manager.getStats().active).toBe(1);

    only.release();
    await drainUntilIdle(manager);
  });

  test('queues message when same conversation already active', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const first = gate(log, 'first');
    const second = gate(log, 'second');

    await manager.acquireLock('same-conv', first.handler);
    await drainUntilStarted(log, 1);

    const queued = await manager.acquireLock('same-conv', second.handler);
    expect(queued.status).toBe('queued-conversation');

    const stats = manager.getStats();
    expect(stats.active).toBe(1);
    expect(stats.queuedTotal).toBe(1);
    expect(stats.queuedByConversation).toEqual([
      { conversationId: 'same-conv', queuedMessages: 1 },
    ]);
    expect(log).toEqual(['first']);

    first.release();
    await drainUntilStarted(log, 2);
    expect(log).toEqual(['first', 'second']);

    second.release();
    await drainUntilIdle(manager);
  });

  test('queues message when at max capacity', async () => {
    const manager = new ConversationLockManager(2);
    const log: string[] = [];
    const one = gate(log, 'conv-1');
    const two = gate(log, 'conv-2');
    const three = gate(log, 'conv-3');

    await manager.acquireLock('conv-1', one.handler);
    await manager.acquireLock('conv-2', two.handler);
    await drainUntilStarted(log, 2);

    // A third distinct conversation has nowhere to run until capacity frees up.
    const queued = await manager.acquireLock('conv-3', three.handler);
    expect(queued.status).toBe('queued-capacity');
    expect(manager.getStats().active).toBe(2);
    expect(manager.getStats().queuedTotal).toBe(1);
    expect(log).toEqual(['conv-1', 'conv-2']);

    // Finishing one occupant is what admits the queued conversation.
    one.release();
    await drainUntilStarted(log, 3);
    expect(log).toEqual(['conv-1', 'conv-2', 'conv-3']);

    two.release();
    three.release();
    await drainUntilIdle(manager);
  });

  test('multiple conversations process concurrently', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const conversations = ['conv-1', 'conv-2', 'conv-3'].map(id => ({ id, gated: gate(log, id) }));

    for (const { id, gated } of conversations) {
      const result = await manager.acquireLock(id, gated.handler);
      expect(result.status).toBe('started');
    }
    await drainUntilStarted(log, 3);

    // None has been released, so all three are genuinely in flight at once.
    const stats = manager.getStats();
    expect(stats.active).toBe(3);
    expect(stats.queuedTotal).toBe(0);
    expect(stats.activeConversationIds.sort()).toEqual(['conv-1', 'conv-2', 'conv-3']);

    for (const { gated } of conversations) gated.release();
    await drainUntilIdle(manager);
  });

  test('queued messages process in order after completion', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const first = gate(log, 'first');
    const second = gate(log, 'second');
    const third = gate(log, 'third');

    await manager.acquireLock('test-conv', first.handler);
    await drainUntilStarted(log, 1);

    await manager.acquireLock('test-conv', second.handler);
    await manager.acquireLock('test-conv', third.handler);
    expect(manager.getStats().queuedTotal).toBe(2);
    expect(log).toEqual(['first']);

    // Each release admits exactly the next message in arrival order.
    first.release();
    await drainUntilStarted(log, 2);
    expect(log).toEqual(['first', 'second']);

    second.release();
    await drainUntilStarted(log, 3);
    expect(log).toEqual(['first', 'second', 'third']);

    third.release();
    await drainUntilIdle(manager);
  });

  test('error in handler does not prevent queue processing', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const failing = gate(log, 'failing', { fail: true });
    const next = gate(log, 'next');

    await manager.acquireLock('test-conv', failing.handler);
    await drainUntilStarted(log, 1);

    await manager.acquireLock('test-conv', next.handler);
    expect(manager.getStats().queuedTotal).toBe(1);

    failing.release();
    await drainUntilStarted(log, 2);
    expect(log).toEqual(['failing', 'next']);

    next.release();
    await drainUntilIdle(manager);
  });

  test('stats stop reporting a conversation once it finishes', async () => {
    const manager = new ConversationLockManager(10);
    const log: string[] = [];
    const a = gate(log, 'conv-a');
    const b = gate(log, 'conv-b');

    await manager.acquireLock('conv-a', a.handler);
    await manager.acquireLock('conv-b', b.handler);
    await drainUntilStarted(log, 2);

    expect(manager.getStats().activeConversationIds.sort()).toEqual(['conv-a', 'conv-b']);

    a.release();
    await drainUntil(
      () => manager.getStats().active === 1,
      'only conv-b active after conv-a finished'
    );
    expect(manager.getStats().activeConversationIds).toEqual(['conv-b']);

    b.release();
    await drainUntilIdle(manager);
    expect(manager.getStats().activeConversationIds).toEqual([]);
  });

  describe('isActive', () => {
    test('tracks one conversation across its whole turn', async () => {
      const manager = new ConversationLockManager(10);
      const log: string[] = [];
      const turn = gate(log, 'a');

      expect(manager.isActive('conv-a')).toBe(false);

      await manager.acquireLock('conv-a', turn.handler);
      await drainUntilStarted(log, 1);
      expect(manager.isActive('conv-a')).toBe(true);
      // Its neighbours are unaffected — the answer is about one id, which is
      // the only reason the route asking it is worth anything.
      expect(manager.isActive('conv-b')).toBe(false);

      turn.release();
      await drainUntilIdle(manager);
      expect(manager.isActive('conv-a')).toBe(false);
    });

    test('a queued message is not active until it starts', async () => {
      // It must say what the lock EVENT would have said, and that fires when
      // the handler starts, not when the message is accepted. A queued message
      // reported as active would disable a composer for a turn not running.
      const manager = new ConversationLockManager(1);
      const log: string[] = [];
      const first = gate(log, 'a');
      const queued = gate(log, 'b');

      await manager.acquireLock('conv-a', first.handler);
      await drainUntilStarted(log, 1);
      const result = await manager.acquireLock('conv-b', queued.handler);
      expect(result.status).toBe('queued-capacity');
      expect(manager.isActive('conv-b')).toBe(false);

      first.release();
      await drainUntilStarted(log, 2);
      expect(manager.isActive('conv-a')).toBe(false);
      expect(manager.isActive('conv-b')).toBe(true);

      queued.release();
      await drainUntilIdle(manager);
    });

    test('a handler that throws still releases the conversation', async () => {
      const manager = new ConversationLockManager(10);
      const log: string[] = [];
      const turn = gate(log, 'a', { fail: true });

      await manager.acquireLock('conv-a', turn.handler);
      await drainUntilStarted(log, 1);
      expect(manager.isActive('conv-a')).toBe(true);

      turn.release();
      await drainUntilIdle(manager);
      expect(manager.isActive('conv-a')).toBe(false);
    });
  });

  describe('drain', () => {
    test('refuses a new conversation instead of queueing it', async () => {
      const manager = new ConversationLockManager(10);
      const log: string[] = [];
      const inFlight = gate(log, 'in-flight');

      await manager.acquireLock('conv-a', inFlight.handler);
      await drainUntilStarted(log, 1);
      manager.beginDrain(60);

      const refused = gate(log, 'refused');
      const result = await manager.acquireLock('conv-b', refused.handler);

      expect(result.status).toBe('refused-draining');
      // Refused, not hidden in a queue: a queued message would be lost by the restart.
      const stats = manager.getStats();
      expect(stats.active).toBe(1);
      expect(stats.queuedTotal).toBe(0);
      expect(log).toEqual(['in-flight']);

      inFlight.release();
      await drainUntilIdle(manager);
    });

    test('lets a turn already in flight run to completion', async () => {
      const manager = new ConversationLockManager(10);
      const log: string[] = [];
      const inFlight = gate(log, 'in-flight');

      await manager.acquireLock('conv-a', inFlight.handler);
      await drainUntilStarted(log, 1);
      manager.beginDrain(60);
      expect(manager.getStats().active).toBe(1);

      inFlight.release();
      await drainUntilIdle(manager);
      expect(manager.getStats().active).toBe(0);
    });

    test('still runs a message queued before drain began', async () => {
      const manager = new ConversationLockManager(10);
      const log: string[] = [];
      const first = gate(log, 'first');
      const queued = gate(log, 'queued');

      await manager.acquireLock('conv-a', first.handler);
      await drainUntilStarted(log, 1);
      const queueResult = await manager.acquireLock('conv-a', queued.handler);
      expect(queueResult.status).toBe('queued-conversation');

      manager.beginDrain(60);
      first.release();

      // The sender was already told this one was accepted; dropping it at dequeue
      // would be the silent loss drain exists to prevent.
      await drainUntilStarted(log, 2);
      expect(log).toEqual(['first', 'queued']);

      queued.release();
      await drainUntilIdle(manager);
      expect(manager.getStats().queuedTotal).toBe(0);
    });

    test('reports what it is still holding while work is in flight', async () => {
      const manager = new ConversationLockManager(10);
      const log: string[] = [];
      const inFlight = gate(log, 'in-flight');

      await manager.acquireLock('conv-a', inFlight.handler);
      await drainUntilStarted(log, 1);
      manager.beginDrain(60);
      expect(manager.getStats().active).toBe(1);

      inFlight.release();
      await drainUntilIdle(manager);
      const stats = manager.getStats();
      expect(stats.active).toBe(0);
      expect(stats.queuedTotal).toBe(0);
    });

    test('counts every refusal so an operator can see the cost', async () => {
      const manager = new ConversationLockManager(10);
      manager.beginDrain(60);

      await manager.acquireLock('conv-a', async () => {});
      await manager.acquireLock('conv-b', async () => {});

      expect(manager.getDrainStatus()?.refusedCount).toBe(2);
    });

    test('cancelDrain restores admission', async () => {
      const manager = new ConversationLockManager(10);
      const log: string[] = [];
      manager.beginDrain(60);
      expect((await manager.acquireLock('conv-a', async () => {})).status).toBe('refused-draining');

      manager.cancelDrain();
      expect(manager.isDraining()).toBe(false);
      expect(manager.getDrainStatus()).toBeUndefined();

      const after = gate(log, 'after');
      expect((await manager.acquireLock('conv-a', after.handler)).status).toBe('started');
      after.release();
      await drainUntilIdle(manager);
    });

    test('cancelDrain is idempotent when not draining', () => {
      const manager = new ConversationLockManager(10);
      manager.cancelDrain();
      expect(manager.isDraining()).toBe(false);
    });

    test('the budget lapses on its own so an abandoned deploy cannot wedge the box', async () => {
      const manager = new ConversationLockManager(10);
      const status = manager.beginDrain(10);
      const expiresAtMs = Date.parse(status.expiresAt);

      expect(manager.isDraining(expiresAtMs - 1)).toBe(true);
      expect(manager.isDraining(expiresAtMs)).toBe(false);
      expect(manager.getDrainStatus()).toBeUndefined();

      const log: string[] = [];
      const after = gate(log, 'after');
      expect((await manager.acquireLock('conv-a', after.handler)).status).toBe('started');
      after.release();
      await drainUntilIdle(manager);
    });

    test('re-requesting replaces the budget and keeps the refusal count', async () => {
      const manager = new ConversationLockManager(10);
      const first = manager.beginDrain(10);
      await manager.acquireLock('conv-a', async () => {});

      const second = manager.beginDrain(60);
      expect(second.requestedAt).toBe(first.requestedAt);
      expect(second.refusedCount).toBe(1);
      expect(Date.parse(second.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
    });

    test('refuses a budget that cannot expire', () => {
      const manager = new ConversationLockManager(10);
      expect(() => manager.beginDrain(0)).toThrow(RangeError);
      expect(() => manager.beginDrain(-1)).toThrow(RangeError);
      expect(() => manager.beginDrain(Number.NaN)).toThrow(RangeError);
      expect(() => manager.beginDrain(Number.POSITIVE_INFINITY)).toThrow(RangeError);
      expect(manager.isDraining()).toBe(false);
    });
  });

  describe('notifyDrainRefusal', () => {
    test('tells the sender only when the refusal was a drain refusal', async () => {
      const sendMessage = mock(async () => {});

      await notifyDrainRefusal('discord', { sendMessage }, 'conv-a', {
        status: 'refused-draining',
      });
      expect(sendMessage).toHaveBeenCalledWith('conv-a', DRAIN_REFUSAL_NOTICE);

      sendMessage.mockClear();
      for (const status of ['started', 'queued-conversation', 'queued-capacity'] as const) {
        await notifyDrainRefusal('discord', { sendMessage }, 'conv-a', { status });
      }
      expect(sendMessage).not.toHaveBeenCalled();
    });

    // The caller has already finished with the message and has nothing to undo, so a
    // failed notice must not become a second failure on top of the refusal.
    test('does not throw when the notice cannot be delivered', async () => {
      const sendMessage = mock(async () => {
        throw new Error('platform unreachable');
      });

      await notifyDrainRefusal('discord', { sendMessage }, 'conv-a', {
        status: 'refused-draining',
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('interrupt', () => {
    test("aborts the running turn's signal and keeps the lock until the handler returns", async () => {
      const manager = new ConversationLockManager();
      let signal: AbortSignal | undefined;
      let finish!: () => void;
      await manager.acquireLock('conv-a', async turn => {
        signal = turn.signal;
        await new Promise<void>(resolve => {
          finish = resolve;
        });
      });

      const ended = manager.interrupt('conv-a');
      expect(ended).toBeDefined();
      expect(signal?.aborted).toBe(true);
      // The handler has not returned, so the conversation is still busy.
      expect(manager.isActive('conv-a')).toBe(true);

      finish();
      await ended;
      await drainUntil(() => !manager.isActive('conv-a'), 'lock released');
    });

    test('returns undefined when nothing is running', () => {
      expect(new ConversationLockManager().interrupt('conv-a')).toBeUndefined();
    });

    test('gives each turn its own signal, so stopping one never pre-aborts the next', async () => {
      const manager = new ConversationLockManager();
      const log: string[] = [];
      const signals: AbortSignal[] = [];
      const first = gate(log, 'first');
      const second = gate(log, 'second');
      await manager.acquireLock('conv-a', async turn => {
        signals.push(turn.signal);
        await first.handler();
      });
      await manager.acquireLock('conv-a', async turn => {
        signals.push(turn.signal);
        await second.handler();
      });

      manager.interrupt('conv-a');
      first.release();
      await drainUntilStarted(log, 2);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      second.release();
      await drainUntilIdle(manager);
    });
  });

  describe('queued messages', () => {
    test('lists described messages oldest first and omits anonymous ones', async () => {
      const manager = new ConversationLockManager();
      const log: string[] = [];
      const running = gate(log, 'running');
      await manager.acquireLock('conv-a', running.handler);
      await manager.acquireLock('conv-a', gate(log, 'a').handler, { text: 'a' });
      await manager.acquireLock('conv-a', gate(log, 'anon').handler);
      await manager.acquireLock('conv-a', gate(log, 'b').handler, { text: 'b' });

      expect(manager.listQueued('conv-a').map(m => m.text)).toEqual(['a', 'b']);
      expect(manager.listQueued('conv-b')).toEqual([]);
    });

    test('withdrawn before delivery: never runs, cleanup runs, and a second withdraw finds nothing', async () => {
      const manager = new ConversationLockManager();
      const log: string[] = [];
      const running = gate(log, 'running');
      const onWithdraw = mock(async () => {});
      await manager.acquireLock('conv-a', running.handler);
      const queued = await manager.acquireLock('conv-a', gate(log, 'typo').handler, {
        text: 'typo',
        onWithdraw,
      });

      const result = manager.withdraw('conv-a', queued.queuedId ?? '');
      expect(result).toMatchObject({ status: 'withdrawn', message: { text: 'typo' } });
      expect(onWithdraw).toHaveBeenCalledTimes(1);
      expect(manager.withdraw('conv-a', queued.queuedId ?? '')).toEqual({ status: 'not-queued' });

      running.release();
      await drainUntilIdle(manager);
      expect(log).toEqual(['running']);
    });

    test('delivered first: withdraw reports not-queued and cleanup never runs', async () => {
      const manager = new ConversationLockManager();
      const log: string[] = [];
      const running = gate(log, 'running');
      const next = gate(log, 'next');
      const onWithdraw = mock(async () => {});
      await manager.acquireLock('conv-a', running.handler);
      const queued = await manager.acquireLock('conv-a', next.handler, {
        text: 'next',
        onWithdraw,
      });

      running.release();
      await drainUntilStarted(log, 2);
      expect(manager.withdraw('conv-a', queued.queuedId ?? '')).toEqual({ status: 'not-queued' });
      expect(onWithdraw).not.toHaveBeenCalled();
      next.release();
      await drainUntilIdle(manager);
      expect(log).toEqual(['running', 'next']);
    });

    test('an anonymous queued message cannot be withdrawn', async () => {
      const manager = new ConversationLockManager();
      const log: string[] = [];
      const running = gate(log, 'running');
      await manager.acquireLock('conv-a', running.handler);
      const queued = await manager.acquireLock('conv-a', gate(log, 'anon').handler);
      expect(manager.withdraw('conv-a', queued.queuedId ?? '')).toEqual({ status: 'not-queued' });
    });
  });
});

describe('parking for a deploy', () => {
  const parkable = (
    text: string
  ): { text: string; parkable: { text: string; attachedFiles: [] } } => ({
    text,
    parkable: { text, attachedFiles: [] },
  });

  test('refuses outside a drain, and touches nothing', async () => {
    const manager = new ConversationLockManager();
    const log: string[] = [];
    const running = gate(log, 'running');
    const next = gate(log, 'next');
    await manager.acquireLock('conv-a', running.handler);
    await manager.acquireLock('conv-a', next.handler, parkable('next'));

    expect(manager.takeForPark('conv-a')).toEqual({ status: 'refused', reason: 'not_draining' });
    expect(manager.listQueued('conv-a').map(m => m.text)).toEqual(['next']);
    running.release();
    await drainUntilStarted(log, 2);
    next.release();
    await drainUntilIdle(manager);
  });

  test('takes every queued message in order, without its withdraw cleanup, so none is ever delivered', async () => {
    const manager = new ConversationLockManager();
    const log: string[] = [];
    const running = gate(log, 'running');
    const onWithdraw = mock(async () => {});
    await manager.acquireLock('conv-a', running.handler);
    await manager.acquireLock('conv-a', gate(log, 'first').handler, {
      ...parkable('first'),
      onWithdraw,
    });
    await manager.acquireLock('conv-a', gate(log, 'second').handler, parkable('second'));
    manager.beginDrain(600);

    const take = manager.takeForPark('conv-a');
    expect(take.status).toBe('taken');
    if (take.status !== 'taken') return;
    expect(take.active).toBe(true);
    expect(take.queued.map(turn => turn.text)).toEqual(['first', 'second']);
    expect(onWithdraw).not.toHaveBeenCalled();
    expect(manager.getParkedConversationIds()).toEqual(['conv-a']);

    running.release();
    await drainUntilIdle(manager);
    // The turn ended and the queue it would have handed off to is empty.
    expect(log).toEqual(['running']);
  });

  test('one message that cannot be saved keeps the whole conversation, in order', async () => {
    const manager = new ConversationLockManager();
    const log: string[] = [];
    const running = gate(log, 'running');
    const described = gate(log, 'described');
    const anon = gate(log, 'anon');
    await manager.acquireLock('conv-a', running.handler);
    await manager.acquireLock('conv-a', described.handler, parkable('described'));
    await manager.acquireLock('conv-a', anon.handler);
    manager.beginDrain(600);

    expect(manager.takeForPark('conv-a')).toEqual({
      status: 'refused',
      reason: 'unparkable_queued_turn',
    });
    expect(manager.getParkedConversationIds()).toEqual([]);

    running.release();
    await drainUntilStarted(log, 2);
    described.release();
    await drainUntilStarted(log, 3);
    anon.release();
    await drainUntilIdle(manager);
    expect(log).toEqual(['running', 'described', 'anon']);
  });

  test('restore puts the messages back at the head and delivers them in order', async () => {
    const manager = new ConversationLockManager();
    const log: string[] = [];
    const running = gate(log, 'running');
    const first = gate(log, 'first');
    const second = gate(log, 'second');
    await manager.acquireLock('conv-a', running.handler);
    await manager.acquireLock('conv-a', first.handler, parkable('first'));
    await manager.acquireLock('conv-a', second.handler, parkable('second'));
    manager.beginDrain(600);

    const take = manager.takeForPark('conv-a');
    if (take.status !== 'taken') throw new Error('expected a take');
    // The turn ends while the take is being persisted...
    running.release();
    await drainUntil(() => !manager.isActive('conv-a'), 'turn ended');
    // ...and the persist fails, so the conversation must be exactly as it was.
    take.restore();
    expect(manager.getParkedConversationIds()).toEqual([]);

    await drainUntilStarted(log, 2);
    first.release();
    await drainUntilStarted(log, 3);
    second.release();
    await drainUntilIdle(manager);
    expect(log).toEqual(['running', 'first', 'second']);
  });

  test("the interrupt's reason reaches the turn, so it can say it was paused for a restart", async () => {
    const manager = new ConversationLockManager();
    let signal: AbortSignal | undefined;
    await manager.acquireLock('conv-a', async turn => {
      signal = turn.signal;
      await new Promise<void>(resolve => turn.signal.addEventListener('abort', () => resolve()));
    });

    await manager.interrupt('conv-a', new DeployParkAbort());
    expect(signal?.reason).toBeInstanceOf(DeployParkAbort);
  });

  test('the parked set and the drain id live and die with the drain', () => {
    const manager = new ConversationLockManager();
    expect(manager.getDrainId()).toBeUndefined();
    manager.beginDrain(600);
    const drainId = manager.getDrainId();
    expect(drainId).toBeDefined();
    manager.takeForPark('conv-idle');
    // Extending the drain keeps both.
    manager.beginDrain(900);
    expect(manager.getDrainId()).toBe(drainId);
    expect(manager.getParkedConversationIds()).toEqual(['conv-idle']);

    manager.cancelDrain();
    expect(manager.getParkedConversationIds()).toEqual([]);
    manager.beginDrain(600);
    expect(manager.getDrainId()).not.toBe(drainId);
  });
});
