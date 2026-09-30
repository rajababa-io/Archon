/**
 * Reactive server-state cache. Map of keyed entities + subscription primitive.
 *
 * Contract:
 * - UI never writes directly — it calls skill verbs; server pushes truth
 *   back via SSE (lib/sse.ts) or refetch on miss.
 * - `useEntity(key, loader)` subscribes to a key. First subscriber triggers
 *   the loader; subsequent subscribers read from cache. After `invalidate()`
 *   or `refetch()`, any key with an active subscriber reloads automatically.
 * - `patch` and `set` are for the SSE dispatcher and skill-layer optimistic
 *   updates only.
 * - After the last unsubscribe, `cache`/`errors` are deliberately retained so
 *   a remount reads warm; only the per-key version counter is released.
 *   `invalidate()` fully releases subscriber-less keys.
 * - A retained value is served to a later subscriber only while it is younger
 *   than `STALE_AFTER_MS`; past that, subscribing revalidates it in place.
 *   Without that, clicking back into a view showed whatever was last fetched
 *   for as long as the tab lived, and only a page reload corrected it.
 * - A resubscribe that arrives while a previous, abandoned load for the key is
 *   still in flight starts its OWN loader; the orphaned load can no longer
 *   clobber the fresh result (per-key `loadSeq` guard, #2101).
 *
 * Deliberately minimal. No React Query, no Zustand.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';

type Listener = () => void;

const cache = new Map<string, unknown>();
const listeners = new Map<string, Set<Listener>>();
const errors = new Map<string, Error>();
const inflight = new Map<string, Promise<unknown>>();
const loaders = new Map<string, () => Promise<unknown>>();
// Per-key change counter. `useEntity` snapshots THIS (not the cached value), so a
// subscriber re-renders on every mutation — including the error transition, where
// the value stays `undefined` and a value-identity snapshot would bail out and
// never surface `error` (e.g. a 401 panel would hang on "Loading…").
const versions = new Map<string, number>();
// Per-key load sequence, bumped each time a load is initiated (via `ensureLoad`
// or `revalidate`). A load captures the value at start and commits its result
// only while the sequence still matches. This neutralizes a load orphaned by
// the last unsubscribe — its promise keeps running (promises aren't
// cancellable) — so it can't overwrite a value produced by a NEWER load that a
// resubscriber started for the same key (#2101). Retained across unsubscribe
// like `cache`/`errors` (so a load that settles with no resubscriber still
// warms the cache) and released together with them by `invalidate()`.
const loadSeq = new Map<string, number>();
// When each key's value last landed from a successful load. Two readers need
// it: `isStale` below, which decides whether a resubscribe revalidates, and
// `fetchedAtOf`, which lets a view say how fresh its data is instead of
// implying it is always current. Retained across unsubscribe alongside
// `cache`/`errors` — the age of a warm value is exactly what a later
// subscriber needs — and released with them by `invalidate()`.
const fetchedAt = new Map<string, number>();

/**
 * How long a warm value is served to a new subscriber before `ensureLoad`
 * revalidates it instead.
 *
 * `useEntity` backs every console panel, so revalidating on every subscribe
 * would turn each remount — a route change, a React StrictMode double mount —
 * into a fresh round of requests for every key the page touches. Two seconds
 * is short enough that returning to a conversation refetches it and long
 * enough to absorb that churn. One window for all keys: no panel has yet
 * needed its own.
 */
const STALE_AFTER_MS = 2_000;

function notify(key: string): void {
  // No subscribers ⇒ nothing snapshots the counter, so don't bump it — a late
  // write (an in-flight load settling after the last unsubscribe, or an SSE
  // push for an unwatched key) would otherwise resurrect the `versions` entry
  // that unsubscribe just released (#1933). Cache/error writes still happen at
  // the call sites so a future remount reads warm.
  const subs = listeners.get(key);
  if (subs === undefined) return;
  versions.set(key, versionOf(key) + 1);
  for (const l of subs) l();
}

/**
 * Shared load runner for both load-initiation paths (`ensureLoad` on first
 * subscribe and `revalidate` on refetch/invalidate). Captures a per-key
 * sequence number so a stale settle — from a load whose key was torn down and
 * re-subscribed with a different loader — no-ops instead of clobbering the
 * current load's result (#2101).
 */
function runLoad(key: string, loader: () => Promise<unknown>): void {
  const seq = (loadSeq.get(key) ?? 0) + 1;
  loadSeq.set(key, seq);
  const p = loader()
    .then(v => {
      if ((loadSeq.get(key) ?? 0) !== seq) return; // superseded by a newer load for this key
      cache.set(key, v);
      fetchedAt.set(key, Date.now());
      errors.delete(key);
      notify(key);
    })
    .catch((e: unknown) => {
      if ((loadSeq.get(key) ?? 0) !== seq) return; // superseded — don't surface a stale error
      const err = e instanceof Error ? e : new Error(String(e));
      errors.set(key, err);
      notify(key); // surface the error; any stale value stays in cache
    })
    .finally(() => {
      // Only clear the entry if it's still THIS load's promise — a newer load
      // for the key may already own `inflight[key]`.
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
}

function isStale(key: string): boolean {
  const at = fetchedAt.get(key);
  // No stamp means the value never came from a loader — `set`/`patch` warmed
  // it — so its age is unknown and a refetch is owed.
  return at === undefined || Date.now() - at >= STALE_AFTER_MS;
}

/**
 * Load on subscribe, unless the key is already loading or holds a value still
 * inside the staleness window. A stale warm key reloads WITHOUT clearing the
 * cache (`runLoad` only writes on resolve), so the subscriber keeps rendering
 * the previous value — no blank, no loading flash — until fresh data lands.
 */
function ensureLoad(key: string): void {
  if (inflight.has(key)) return;
  if (cache.has(key) && !isStale(key)) return;
  const loader = loaders.get(key);
  if (loader === undefined) return;
  runLoad(key, loader);
}

export function get(key: string): unknown {
  return cache.get(key);
}

export function set(key: string, value: unknown): void {
  cache.set(key, value);
  // Deliberately NOT stamped: `fetchedAt` records when the SERVER last
  // confirmed a value, and a pushed one carries no such confirmation. Stamping
  // here would let a push hold a key warm through the staleness window and
  // silently defeat revalidation on resubscribe.
  errors.delete(key);
  notify(key);
}

/**
 * Write a value derived from the one already held, for the rare event that
 * carries its own answer (see primitives/live-activity). Everything else
 * invalidates and refetches.
 *
 * An updater that returns what it was given changes NOTHING: no entry, no
 * notify. That is not an optimisation — a key with no value yet is a key whose
 * loader has not run, and `ensureLoad` skips any key the cache already holds.
 * Installing `undefined` under it would mean the load never happens and the key
 * stays empty until something invalidates it. So an updater that declines to
 * act (because there is nothing to patch yet) leaves the cache untouched and
 * the load on its way.
 */
export function patch(key: string, updater: (prev: unknown) => unknown): void {
  const prev = cache.get(key);
  const next = updater(prev);
  if (next === prev) return;
  cache.set(key, next);
  notify(key);
}

/**
 * Revalidate one key in place (stale-while-revalidate). Re-runs the loader and
 * swaps the value in on resolve WITHOUT clearing the cache first — so a
 * subscriber keeps seeing the previous value until fresh data lands, instead of
 * flashing to `undefined`/empty on every refresh. That flash, at SSE/poll
 * cadence, made live message updates flicker and never settle.
 *
 * If no subscriber is registered (no loader), drop the entry so the next mount
 * fetches fresh.
 */
function revalidate(key: string): void {
  const loader = loaders.get(key);
  if (loader === undefined) {
    cache.delete(key);
    errors.delete(key);
    versions.delete(key); // fully release the key — nothing subscribes, so nothing snapshots it
    // Release the sequence and the freshness stamp alongside cache/errors —
    // they all describe the value that just went away and move together.
    loadSeq.delete(key);
    fetchedAt.delete(key);
    return;
  }
  if (inflight.has(key)) return; // a revalidation is already in flight
  runLoad(key, loader);
}

export function invalidate(keyPrefix: string): void {
  // Match by exact key OR by `${prefix}:` so callers can pass either a
  // concrete key (`run:abc`) or a prefix that fans out (`runs`).
  const matches = (key: string): boolean => key === keyPrefix || key.startsWith(`${keyPrefix}:`);

  // Walk both the data cache AND the errors map. An errored key lives only in
  // `errors`, so iterating `cache.keys()` alone would leave it permanently
  // stuck — the loader would never refetch and the UI would require a full
  // page reload to recover.
  const toRefresh = new Set<string>();
  for (const key of [...cache.keys()]) {
    if (matches(key)) toRefresh.add(key);
  }
  for (const key of [...errors.keys()]) {
    if (matches(key)) toRefresh.add(key);
  }
  for (const key of toRefresh) {
    revalidate(key);
  }
}

export function keysStartingWith(prefix: string): string[] {
  const out: string[] = [];
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) out.push(k);
  }
  return out;
}

/**
 * Module-level subscription primitive backing `useEntity`. A plain function
 * (not a hook) so the subscribe/unsubscribe lifecycle is unit-testable — the
 * same extraction shape as `handleBuilderKeydown` in `useBuilderKeyboard`.
 *
 * Exported for tests; production code subscribes via `useEntity`, whose
 * `useSyncExternalStore` wiring guarantees the returned cleanup runs.
 */
export function subscribeKey(
  key: string,
  onStoreChange: Listener,
  loader: () => Promise<unknown>
): () => void {
  let subs = listeners.get(key);
  if (subs === undefined) {
    subs = new Set();
    listeners.set(key, subs);
  }
  subs.add(onStoreChange);

  loaders.set(key, loader);
  ensureLoad(key);

  return (): void => {
    const remainingSubs = listeners.get(key);
    if (remainingSubs === undefined) return;
    remainingSubs.delete(onStoreChange);
    if (remainingSubs.size === 0) {
      listeners.delete(key);
      loaders.delete(key);
      // Drop the change counter too — with no subscribers nothing snapshots it,
      // and `useSyncExternalStore` only compares snapshots for change, so a
      // remount starting back at 0 behaves identically. Without this the
      // `versions` Map grows unbounded across every key a session ever touches
      // (#1933); `notify` refuses to bump subscriber-less keys, so a load still
      // in flight here cannot resurrect the entry. `cache` and `errors` are
      // deliberately retained so a remount reads warm (see the module contract
      // above); `invalidate()` releases them for subscriber-less keys via
      // `revalidate`'s no-loader branch.
      versions.delete(key);
      // Detach any in-flight load. Promises aren't cancellable, so it keeps
      // running and may still warm the cache for a future remount (guarded by
      // its `loadSeq`), but dropping it from `inflight` here means a resubscribe
      // arriving before it settles runs its OWN loader via `ensureLoad` instead
      // of inheriting this abandoned request's eventual result (#2101).
      inflight.delete(key);
    }
  };
}

/** Snapshot of the per-key change counter — `useEntity`'s store snapshot. */
export function versionOf(key: string): number {
  return versions.get(key) ?? 0;
}

export interface EntityView<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refetch: () => void;
  /** Epoch ms of the last successful load; `undefined` until one lands. */
  fetchedAt: number | undefined;
}

/** When this key last loaded, for callers that are not using useEntity. */
export function fetchedAtOf(key: string): number | undefined {
  return fetchedAt.get(key);
}

/**
 * A loader paired with the key it was rendered for. The two are never
 * separated, because a loader is only ever a correct answer for one key:
 * `() => getProjectCounts(projectId)` answers `projectCounts:<projectId>` and
 * nothing else.
 */
export interface KeyedLoader<T> {
  key: string;
  loader: () => Promise<T>;
}

/**
 * Which loader may answer for `key`.
 *
 * `loaders` above is one module-global map, so a loader reached through a bare
 * ref can be invoked under a key it was never written for. `useEntity` rewrites
 * that ref DURING render, and a render for project B lands while the committed
 * tree is still subscribed under project A's key — React re-subscribes in a
 * later passive effect, and discards renders outright. The next `invalidate`
 * then runs B's loader under A's key and writes B's numbers into A's entry,
 * where A's row reads them as its own. That is how three project rows came to
 * show a fourth project's counts.
 *
 * `held` is taken only while it still names this key — that is what the ref is
 * for, so a loader closing over props that changed WITHOUT changing the key is
 * not stale. Otherwise `rendered`, the loader from the render that produced the
 * subscription, which named this key by construction.
 *
 * A plain function rather than logic inline in the hook, so the crossing it
 * refuses is unit-testable — the same extraction shape as `subscribeKey`.
 */
export function loaderForKey<T>(
  key: string,
  held: KeyedLoader<T>,
  rendered: () => Promise<T>
): () => Promise<T> {
  return held.key === key ? held.loader : rendered;
}

/**
 * Subscribe to a keyed entity. On first subscribe (or after `refetch`),
 * invokes `loader`. Updates propagate to all subscribers via `notify`.
 *
 * Uses `useSyncExternalStore` so React reads a consistent snapshot and commits
 * the latest value — the previous manual `useState(n => n + 1)` subscription
 * could commit a stale render (the store mutates outside React's knowledge), so
 * a refetched value would land in the cache but never appear on screen until a
 * remount. `notify` is the store's change signal; `getSnapshot` reads the per-key
 * version counter (see below) so error transitions re-render too.
 */
export function useEntity<T>(key: string, loader: () => Promise<T>): EntityView<T> {
  // Carried as a pair so the two can never cross — see `loaderForKey`.
  const latest = useRef<KeyedLoader<T>>({ key, loader });
  latest.current = { key, loader };

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      subscribeKey(key, onStoreChange, () => loaderForKey(key, latest.current, loader)()),
    // `loader` is a new closure every render and is deliberately not a
    // dependency: re-subscribing on each render would re-run the load. The one
    // captured here belongs to the render that produced this `key`, which is
    // exactly the fallback `loaderForKey` needs.
    [key]
  );

  // Snapshot the per-key version counter (a number bumped on every `notify`), not
  // the cached value: that way the component re-renders on the error transition too
  // — where `cache.get(key)` stays `undefined` and a value-identity snapshot would
  // bail out, leaving `error` unread. `data`/`error`/`loading` are read fresh from
  // the maps below on each (synchronous) render. They can briefly co-exist in
  // intermediate states — e.g. `loading` is still true when an error first lands
  // (`inflight` clears in a later `.finally`) — so consumers check `error` before
  // `loading`, as the panels do.
  useSyncExternalStore(
    subscribe,
    () => versionOf(key),
    () => versionOf(key)
  );

  return {
    data: cache.get(key) as T | undefined,
    error: errors.get(key),
    loading: !cache.has(key) && inflight.has(key),
    fetchedAt: fetchedAt.get(key),
    refetch: (): void => {
      revalidate(key);
    },
  };
}

/**
 * `useEntity` over a list of keys, for a view that reads many entries at once
 * — a total across rows that each read their own. A hook cannot be called in
 * a loop, so this subscribes to every key through the same `subscribeKey`
 * primitive and re-renders when any one of them changes.
 *
 * Each item carries its own loader, paired with its key for the same reason
 * `KeyedLoader` exists: a loader is only ever a correct answer for one key.
 * Subscribing alongside a row that already reads the key costs no extra
 * request — the load is shared through `inflight` and the cache.
 */
export function useEntities<T>(items: readonly KeyedLoader<T>[]): (T | undefined)[] {
  return useEntityViews(items).map(v => v.data);
}

/** One entry as {@link useEntityViews} reports it: `useEntity`'s view, minus the refetch. */
export type EntrySnapshot<T> = Pick<EntityView<T>, 'data' | 'error' | 'fetchedAt'>;

/**
 * {@link useEntities} with each entry's error and freshness as well, for a view
 * that must say WHICH of many reads failed rather than only total the ones
 * that landed — a board across every project.
 */
export function useEntityViews<T>(items: readonly KeyedLoader<T>[]): EntrySnapshot<T>[] {
  const latest = useRef(items);
  latest.current = items;
  const keysSig = items.map(i => i.key).join('\n');

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const offs = latest.current.map(i => subscribeKey(i.key, onStoreChange, i.loader));
      return (): void => {
        for (const off of offs) off();
      };
    },
    // Keyed on the key LIST, not the item array: a new array each render with
    // the same keys must not tear down and re-run every load.
    [keysSig]
  );

  // A string of the per-key version counters: strings compare by value, so the
  // snapshot is stable until some key actually changes.
  const snapshot = (): string => latest.current.map(i => versionOf(i.key)).join(',');
  useSyncExternalStore(subscribe, snapshot, snapshot);

  return items.map(i => ({
    data: cache.get(i.key) as T | undefined,
    error: errors.get(i.key),
    fetchedAt: fetchedAt.get(i.key),
  }));
}
