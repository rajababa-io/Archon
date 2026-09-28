import { describe, expect, test } from 'bun:test';
import { OPEN_PATH_MESSAGE } from './paths';
import { serviceWorkerSource } from './vite-plugin';

type Listener = (event: FakeEvent) => void;
interface FakeEvent {
  waitUntil(p: Promise<unknown>): void;
  data?: { json(): unknown };
  notification?: { data: unknown; close(): void };
}
interface FakeWindow {
  url: string;
  focused: boolean;
  messages: unknown[];
  postMessage(m: unknown): void;
  focus(): Promise<unknown>;
}

function fakeWindow(url: string, focusFails = false): FakeWindow {
  const w: FakeWindow = {
    url,
    focused: false,
    messages: [],
    postMessage: m => w.messages.push(m),
    focus: () =>
      focusFails ? Promise.reject(new Error('gone')) : ((w.focused = true), Promise.resolve(w)),
  };
  return w;
}

/** Load the emitted worker against a fake `self` and return its listeners. */
function loadWorker(opts: {
  windows?: FakeWindow[];
  showNotification?: (title: string, options: Record<string, unknown>) => Promise<void>;
}): { listeners: Map<string, Listener>; opened: string[] } {
  const listeners = new Map<string, Listener>();
  const opened: string[] = [];
  const self = {
    location: { origin: 'https://archon.test' },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    registration: { showNotification: opts.showNotification ?? (() => Promise.resolve()) },
    clients: {
      matchAll: () => Promise.resolve(opts.windows ?? []),
      openWindow: (path: string) => (opened.push(path), Promise.resolve(null)),
    },
  };
  new Function('self', 'caches', serviceWorkerSource([]))(self, {});
  return { listeners, opened };
}

async function dispatch(
  listener: Listener | undefined,
  event: Omit<FakeEvent, 'waitUntil'>
): Promise<void> {
  let pending: Promise<unknown> = Promise.resolve();
  listener?.({ ...event, waitUntil: p => (pending = p) });
  await pending;
}

const tap = (path: string): Omit<FakeEvent, 'waitUntil'> => ({
  notification: { data: { path }, close: () => undefined },
});

describe('service worker notificationclick', () => {
  test('focuses a shell window sitting on the bare /m home instead of opening another', async () => {
    const home = fakeWindow('https://archon.test/m');
    const { listeners, opened } = loadWorker({ windows: [home] });
    await dispatch(listeners.get('notificationclick'), tap('/m/c/abc'));
    expect(home.focused).toBe(true);
    expect(home.messages).toEqual([{ type: OPEN_PATH_MESSAGE, path: '/m/c/abc' }]);
    expect(opened).toEqual([]);
  });

  test('a desktop console window is not the shell', async () => {
    const desktop = fakeWindow('https://archon.test/console');
    const { listeners, opened } = loadWorker({ windows: [desktop] });
    await dispatch(listeners.get('notificationclick'), tap('/m/r/run-1'));
    expect(desktop.focused).toBe(false);
    expect(opened).toEqual(['/m/r/run-1']);
  });

  test('a window that closes before it can be focused falls back to opening the page', async () => {
    const closing = fakeWindow('https://archon.test/m/c/abc', true);
    const { listeners, opened } = loadWorker({ windows: [closing] });
    await dispatch(listeners.get('notificationclick'), tap('/m/c/xyz'));
    expect(opened).toEqual(['/m/c/xyz']);
  });

  test('a path outside the shell opens the shell home', async () => {
    const { listeners, opened } = loadWorker({});
    await dispatch(listeners.get('notificationclick'), tap('/console'));
    expect(opened).toEqual(['/m/']);
  });
});

describe('service worker push', () => {
  test('a rejected notification is retried as plain text', async () => {
    const shown: { title: string; options: Record<string, unknown> }[] = [];
    const { listeners } = loadWorker({
      showNotification: (title, options) => {
        shown.push({ title, options });
        return shown.length === 1 ? Promise.reject(new Error('icon')) : Promise.resolve();
      },
    });
    await dispatch(listeners.get('push'), {
      data: { json: () => ({ title: 'Ask', body: 'Ship?', tag: 'chat:1', path: '/m/c/1' }) },
    });
    expect(shown).toHaveLength(2);
    expect(shown[1]).toEqual({
      title: 'Ask',
      options: { body: 'Ship?', data: { path: '/m/c/1' } },
    });
  });
});
