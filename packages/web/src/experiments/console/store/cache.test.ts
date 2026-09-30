import { describe, test, expect, afterEach, setSystemTime } from 'bun:test';
import { subscribeKey, versionOf, get, patch, set, invalidate, loaderForKey } from './cache';

// The store's Maps are module-level, so every test uses its own unique key —
// no cross-test state to reset.

// Tests that exercise the staleness window pin the clock. Reset it for every
// test so a pinned one can never leak into the next; a no-op otherwise.
afterEach(() => {
  setSystemTime();
});

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('subscribeKey — per-key Map lifecycle (#1933)', () => {
  test('last unsubscribe prunes versions; cache is retained for warm remount', async () => {
    const key = 'test:prune-versions';
    // Frozen so the remount below is unambiguously inside the staleness window.
    setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    let loads = 0;
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('v1');
      }
    );
    await flush();

    expect(get(key)).toBe('v1');
    expect(versionOf(key)).toBe(1); // notify bumped on load resolve
    expect(loads).toBe(1);

    unsubscribe();
    expect(versionOf(key)).toBe(0); // counter released
    expect(get(key)).toBe('v1'); // cached value deliberately retained

    // Remount inside the window reads warm: ensureLoad short-circuits on the
    // still-fresh cached value.
    const unsubscribe2 = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('v2');
      }
    );
    await flush();
    expect(get(key)).toBe('v1');
    expect(loads).toBe(1); // loader not re-invoked
    unsubscribe2();
  });

  test('unsubscribing a non-last subscriber keeps the counter', async () => {
    const key = 'test:non-last';
    const unsubA = subscribeKey(
      key,
      () => {},
      () => Promise.resolve('a')
    );
    const unsubB = subscribeKey(
      key,
      () => {},
      () => Promise.resolve('a')
    );
    await flush();
    expect(versionOf(key)).toBe(1);

    unsubA();
    expect(versionOf(key)).toBe(1); // B still subscribed

    unsubB();
    expect(versionOf(key)).toBe(0);
  });

  test('unsubscribe stops change notifications', async () => {
    const key = 'test:notify-stops';
    let renders = 0;
    const unsubscribe = subscribeKey(
      key,
      () => {
        renders += 1;
      },
      () => Promise.resolve('a')
    );
    await flush();
    expect(renders).toBe(1);

    unsubscribe();
    set(key, 'b');
    expect(renders).toBe(1); // no further signal after cleanup
  });

  test('invalidate fully releases a subscriber-less key (cache + versions)', async () => {
    const key = 'test:invalidate-prune';
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => Promise.resolve('a')
    );
    await flush();
    unsubscribe();

    // An SSE push for an unsubscribed key updates the still-warm cache; the
    // version counter stays released because notify skips subscriber-less keys.
    set(key, 'pushed');
    expect(get(key)).toBe('pushed');
    expect(versionOf(key)).toBe(0);

    // With no loader registered, revalidate's prune branch drops the cache too.
    invalidate(key);
    expect(get(key)).toBeUndefined();
    expect(versionOf(key)).toBe(0);
  });

  test('a load resolving after the last unsubscribe does not resurrect the counter', async () => {
    const key = 'test:inflight-resolve';
    let resolveLoad: (v: string) => void = () => {};
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolveLoad = resolve;
        })
    );

    unsubscribe(); // last subscriber leaves while the load is still in flight
    expect(versionOf(key)).toBe(0);

    resolveLoad('late');
    await flush();
    expect(versionOf(key)).toBe(0); // notify skipped — nothing subscribes
    expect(get(key)).toBe('late'); // cache still warms for a future remount
  });

  test('a load rejecting after the last unsubscribe does not resurrect the counter', async () => {
    const key = 'test:inflight-reject';
    let rejectLoad: (e: Error) => void = () => {};
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectLoad = reject;
        })
    );

    unsubscribe();
    expect(versionOf(key)).toBe(0);

    rejectLoad(new Error('late boom'));
    await flush();
    expect(versionOf(key)).toBe(0);
  });

  test('invalidate by prefix releases every matching subscriber-less key', async () => {
    const unsubA = subscribeKey(
      'test-prefix:a',
      () => {},
      () => Promise.resolve('a')
    );
    const unsubB = subscribeKey(
      'test-prefix:b',
      () => {},
      () => Promise.resolve('b')
    );
    await flush();
    unsubA();
    unsubB();

    invalidate('test-prefix');
    expect(get('test-prefix:a')).toBeUndefined();
    expect(get('test-prefix:b')).toBeUndefined();
    expect(versionOf('test-prefix:a')).toBe(0);
    expect(versionOf('test-prefix:b')).toBe(0);
  });

  test('errored key still releases its counter on last unsubscribe', async () => {
    const key = 'test:error-prune';
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => Promise.reject(new Error('boom'))
    );
    await flush();
    expect(get(key)).toBeUndefined();
    expect(versionOf(key)).toBe(1); // error transition notified

    unsubscribe();
    expect(versionOf(key)).toBe(0);
  });
});

describe('subscribeKey — resubscribe during an abandoned in-flight load (#2101)', () => {
  test('a resubscribe before the old load settles runs its own loader and wins', async () => {
    const key = 'test:resub-inflight';
    let resolveA: (v: string) => void = () => {};
    let bLoads = 0;

    const unsubA = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolveA = resolve;
        })
    );
    unsubA(); // last subscriber leaves while loaderA is still pending

    const unsubB = subscribeKey(
      key,
      () => {},
      () => {
        bLoads += 1;
        return Promise.resolve('B');
      }
    );
    await flush();

    expect(bLoads).toBe(1); // B's own loader ran (the bug: it was never invoked)
    expect(get(key)).toBe('B'); // B's result landed
    expect(versionOf(key)).toBe(1); // one notify, from B's load

    resolveA('A'); // the abandoned load settles late
    await flush();
    expect(get(key)).toBe('B'); // A does not clobber B
    expect(versionOf(key)).toBe(1); // A's stale settle did not notify

    unsubB();
  });

  test('a rejecting abandoned load does not surface an error to the resubscriber', async () => {
    const key = 'test:resub-reject';
    let rejectA: (e: Error) => void = () => {};

    const unsubA = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectA = reject;
        })
    );
    unsubA();

    const unsubB = subscribeKey(
      key,
      () => {},
      () => Promise.resolve('B')
    );
    await flush();
    expect(get(key)).toBe('B');
    expect(versionOf(key)).toBe(1);

    rejectA(new Error('stale boom')); // loaderA rejects after B already resolved
    await flush();
    expect(get(key)).toBe('B'); // B's value untouched
    expect(versionOf(key)).toBe(1); // no extra notify — A's error was not surfaced

    unsubB();
  });
});

describe('patch — a value derived from the one already held', () => {
  test('updates the entry and wakes its subscribers', async () => {
    const key = 'test:patch-updates';
    const seen: unknown[] = [];
    const unsubscribe = subscribeKey(
      key,
      () => {
        seen.push(get(key));
      },
      () => Promise.resolve({ n: 1 })
    );
    await flush();

    patch(key, prev => ({ n: (prev as { n: number }).n + 1 }));
    expect(get(key)).toEqual({ n: 2 });
    expect(seen.at(-1)).toEqual({ n: 2 });
    unsubscribe();
  });

  test('an updater that declines to act leaves the load on its way', async () => {
    // A patch on a key that has not loaded must not install `undefined` under
    // it: `ensureLoad` skips any key the cache already holds, so that entry
    // would mean the loader never runs and the key stays empty.
    const key = 'test:patch-declines';
    let loads = 0;

    patch(key, prev => prev);

    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('loaded');
      }
    );
    await flush();

    expect(loads).toBe(1);
    expect(get(key)).toBe('loaded');
    unsubscribe();
  });

  test('a patch that changes nothing does not wake subscribers', async () => {
    const key = 'test:patch-noop';
    const held = { n: 1 };
    let notifications = 0;
    const unsubscribe = subscribeKey(
      key,
      () => {
        notifications += 1;
      },
      () => Promise.resolve(held)
    );
    await flush();
    const before = notifications;

    patch(key, prev => prev);
    expect(notifications).toBe(before);
    unsubscribe();
  });
});

describe('subscribeKey — staleness window on resubscribe', () => {
  const START = new Date('2026-01-01T00:00:00.000Z');

  function at(offsetMs: number): void {
    setSystemTime(new Date(START.getTime() + offsetMs));
  }

  test('a resubscribe inside the window serves the warm value without reloading', async () => {
    const key = 'test:fresh-resubscribe';
    setSystemTime(START);

    let loads = 0;
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('v1');
      }
    );
    await flush();
    expect(get(key)).toBe('v1');
    expect(loads).toBe(1);
    unsubscribe();

    at(1_999); // still inside the 2s window
    const unsubscribe2 = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('v2');
      }
    );
    await flush();

    expect(loads).toBe(1); // loader not re-invoked
    expect(get(key)).toBe('v1');
    unsubscribe2();
  });

  test('a resubscribe past the window revalidates without blanking the cached value', async () => {
    const key = 'test:stale-resubscribe';
    setSystemTime(START);

    let loads = 0;
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('v1');
      }
    );
    await flush();
    expect(get(key)).toBe('v1');
    unsubscribe();

    at(2_000); // the value is now as old as the window allows
    let resolveSecond: (v: string) => void = () => {};
    const unsubscribe2 = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return new Promise<string>(resolve => {
          resolveSecond = resolve;
        });
      }
    );

    expect(loads).toBe(2); // the resubscribe issued its own request

    // Stale-while-revalidate: the previous value is still on screen while the
    // refetch is in flight — never blanked to undefined, never a loading flash.
    expect(get(key)).toBe('v1');

    resolveSecond('v2');
    await flush();
    expect(get(key)).toBe('v2');

    unsubscribe2();
  });

  test('the window is measured from the last load, not from the last subscribe', async () => {
    const key = 'test:window-origin';
    setSystemTime(START);

    let loads = 0;
    const loader = (): Promise<string> => {
      loads += 1;
      return Promise.resolve(`v${loads.toString()}`);
    };

    const unsubscribe = subscribeKey(key, () => {}, loader);
    await flush();
    expect(loads).toBe(1);
    unsubscribe();

    // Three subscribes spread across the window: the value's age keeps growing
    // because none of them reloaded, so only the one past 2s refetches.
    at(800);
    subscribeKey(key, () => {}, loader)();
    at(1_600);
    subscribeKey(key, () => {}, loader)();
    await flush();
    expect(loads).toBe(1);

    at(2_400);
    const unsubscribe4 = subscribeKey(key, () => {}, loader);
    await flush();
    expect(loads).toBe(2);
    expect(get(key)).toBe('v2');
    unsubscribe4();
  });

  test('a key warmed only by set() always reloads on subscribe, then joins the window', async () => {
    const key = 'test:pushed-value-subscribe';
    setSystemTime(START);

    // An SSE push or an optimistic skill-layer write. Nothing stamps its age,
    // so the window cannot apply to it and the first subscriber is owed a load.
    set(key, 'pushed');

    let loads = 0;
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('loaded');
      }
    );

    expect(loads).toBe(1);
    expect(get(key)).toBe('pushed'); // still on screen while that load is in flight
    await flush();
    expect(get(key)).toBe('loaded');
    unsubscribe();

    // One load converges it: the value now has an age, so the window applies.
    const unsubscribe2 = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('again');
      }
    );
    await flush();
    expect(loads).toBe(1);
    expect(get(key)).toBe('loaded');
    unsubscribe2();
  });
});

/**
 * A project row showed another project's numbers: `Archon`, `Wix Access` and
 * `Vault` all read the same pair, which was archon's. The cause was not the
 * fetch (correctly scoped), nor the key (`projectCounts:<id>`, per project),
 * but the loader reached BETWEEN them — `useEntity` rewrites its loader ref
 * during render, and `loaders` is one module-global map, so a loader rendered
 * for one project could be invoked under another project's key.
 */
describe('loaderForKey — a loader answers only for the key it was rendered for', () => {
  const rendered = (): Promise<string> => Promise.resolve('rendered-for-this-key');

  test('a ref still naming this key is used, so changed props are not stale', async () => {
    const held = { key: 'projectCounts:archon', loader: () => Promise.resolve('fresher') };
    await expect(loaderForKey('projectCounts:archon', held, rendered)()).resolves.toBe('fresher');
  });

  test('a ref repointed at another project is refused, not invoked', async () => {
    // What a render for vault leaves behind while the committed tree is still
    // subscribed under archon's key.
    const held = { key: 'projectCounts:vault', loader: () => Promise.resolve('vault-counts') };
    await expect(loaderForKey('projectCounts:archon', held, rendered)()).resolves.toBe(
      'rendered-for-this-key'
    );
  });
});

describe("invalidate cannot write one project's counts under another's key", () => {
  /**
   * The whole chain, against the real store: subscribe under archon's key,
   * repoint the component's ref at vault (a render), then let the dashboard
   * stream fire `invalidate('projectCounts')` before React has re-subscribed.
   * Before the fix this left vault's numbers in archon's entry, permanently.
   */
  test('a repointed ref cannot contaminate the key it is still subscribed under', async () => {
    const archon = 'projectCounts:test-contamination-archon';
    const vault = 'projectCounts:test-contamination-vault';
    const archonLoader = (): Promise<unknown> => Promise.resolve({ chats: 15 });
    const vaultLoader = (): Promise<unknown> => Promise.resolve({ chats: 2 });

    // One component instance, rendered for archon.
    const ref = { current: { key: archon, loader: archonLoader } };
    const unsubscribe = subscribeKey(
      archon,
      () => {},
      () => loaderForKey(archon, ref.current, archonLoader)()
    );
    await flush();
    expect(get(archon)).toEqual({ chats: 15 });

    // It re-renders for vault. The ref moves during render; the re-subscribe
    // to vault's key happens later, in a passive effect.
    ref.current = { key: vault, loader: vaultLoader };

    // A dashboard event lands inside that window.
    invalidate('projectCounts');
    await flush();

    expect(get(archon)).toEqual({ chats: 15 });
    unsubscribe();
  });
});

describe('invalidate — during an in-flight load (#308)', () => {
  test('reloads once more after the in-flight load settles', async () => {
    const key = 'test:invalidate-during-load';
    const resolvers: ((v: string) => void)[] = [];
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolvers.push(resolve);
        })
    );
    resolvers[0]('initial');
    await flush();

    // Two writes land back to back, each invalidating. The first starts a load
    // that read the server before the second write committed.
    invalidate(key);
    expect(resolvers.length).toBe(2);
    invalidate(key);
    invalidate(key);
    expect(resolvers.length).toBe(2); // coalesced — no request per invalidate

    resolvers[1]('after first write');
    await flush();
    expect(get(key)).toBe('after first write'); // still on screen meanwhile
    expect(resolvers.length).toBe(3); // exactly one follow-up for the burst

    resolvers[2]('after both writes');
    await flush();
    expect(get(key)).toBe('after both writes');
    expect(resolvers.length).toBe(3);

    unsubscribe();
  });

  test('an invalidate owed to a key that lost its subscriber is not run', async () => {
    const key = 'test:invalidate-during-load-unsub';
    const resolvers: ((v: string) => void)[] = [];
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolvers.push(resolve);
        })
    );
    resolvers[0]('v1');
    await flush();
    invalidate(key);
    invalidate(key); // owed a follow-up
    unsubscribe(); // ...but nothing is watching any more
    resolvers[1]('v2');
    await flush();
    expect(resolvers.length).toBe(2);
  });
});
