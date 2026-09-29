import { afterAll, beforeEach, describe, test, expect } from 'bun:test';
import {
  ALL_PROJECTS_SCOPE,
  loadServerViews,
  parseProjectView,
  projectViewKey,
  readProjectView,
  resetProjectViewState,
  writeProjectView,
} from './project-view';

/** The browser's store, as much of it as this module touches. Bun has no DOM. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string): string | null => store.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    store.set(k, v);
  },
  removeItem: (k: string): void => {
    store.delete(k);
  },
  clear: (): void => {
    store.clear();
  },
};

/** The server, as the view routes answer it: 401 with no signed-in person. */
let serverViews: Record<string, string> | null = null;
const puts: unknown[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
  if (serverViews === null) return Response.json({ error: 'no pass' }, { status: 401 });
  return Response.json({ views: serverViews });
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  store.clear();
  puts.length = 0;
  serverViews = null;
  resetProjectViewState();
});

describe('parseProjectView', () => {
  test('accepts the real views', () => {
    expect(parseProjectView('runs')).toBe('runs');
    expect(parseProjectView('chat')).toBe('chat');
  });

  test('an absent preference reads as null', () => {
    expect(parseProjectView(null)).toBeNull();
  });

  test('an unrecognized value reads as no preference, not as a route', () => {
    // A stale key from an older build, or a hand-edited value, must not send
    // the user to a view that does not exist.
    expect(parseProjectView('builder')).toBeNull();
    expect(parseProjectView('')).toBeNull();
    expect(parseProjectView('RUNS')).toBeNull();
  });
});

describe('projectViewKey', () => {
  test('scopes the preference per project, and All projects apart from every project', () => {
    expect(projectViewKey('a')).not.toBe(projectViewKey('b'));
    expect(projectViewKey(ALL_PROJECTS_SCOPE)).not.toBe(projectViewKey('a'));
  });

  test('is namespaced so it cannot collide with another console key', () => {
    expect(projectViewKey('a')).toStartWith('archon.console.');
  });
});

describe('server copy', () => {
  test('a pick is kept here and sent to the server', async () => {
    writeProjectView(ALL_PROJECTS_SCOPE, 'chat');
    expect(readProjectView(ALL_PROJECTS_SCOPE)).toBe('chat');
    await Promise.resolve();
    expect(puts).toEqual([{ scopeId: '', view: 'chat' }]);
  });

  test("the signed-in person's choices replace this browser's on load", async () => {
    store.set(projectViewKey('p1'), 'runs');
    serverViews = { '': 'chat', p1: 'issues' };
    await loadServerViews();
    expect(readProjectView(ALL_PROJECTS_SCOPE)).toBe('chat');
    expect(readProjectView('p1')).toBe('issues');
  });

  test('a pick made before the server answers is not undone by it', async () => {
    serverViews = { '': 'runs' };
    writeProjectView(ALL_PROJECTS_SCOPE, 'chat');
    await loadServerViews();
    expect(readProjectView(ALL_PROJECTS_SCOPE)).toBe('chat');
  });

  test('with nobody signed in, this browser keeps its own copy', async () => {
    store.set(projectViewKey('p1'), 'files');
    await loadServerViews();
    expect(readProjectView('p1')).toBe('files');
  });
});
