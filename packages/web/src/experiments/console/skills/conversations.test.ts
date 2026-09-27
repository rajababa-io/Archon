/**
 * How a listing reports its own incompleteness.
 *
 * The route caps what it returns and counts separately, so `chats.length` and
 * `total` are different numbers on purpose. Getting that wrong is invisible
 * until a project has enough finished chats to cross the cap, which is exactly
 * when nobody is looking.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { listAllConversations, listConversations } from './conversations';

const originalFetch = globalThis.fetch;
let requested: string[] = [];

function stubList(body: unknown): void {
  requested = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    requested.push(typeof input === 'string' ? input : input.toString());
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as typeof fetch;
}

const row = (id: string): Record<string, unknown> => ({
  id,
  platform_conversation_id: id,
  platform_type: 'web',
  title: id,
  completed_at: null,
  last_activity_at: '2026-09-01T10:00:00.000Z',
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('listConversations', () => {
  beforeEach(() => {
    requested = [];
  });

  test('total is the count for the scope that was asked for', async () => {
    // The server ignores `state` when counting, so all three scopes come back
    // every time. Picking the wrong one would report the done tab's size on
    // the open tab.
    stubList({
      conversations: [row('a')],
      counts: { open: 1, done: 112, all: 113 },
    });
    const list = await listConversations('project-1', 'done');
    expect(list.total).toBe(112);
    expect(list.counts).toEqual({ open: 1, done: 112, all: 113 });
  });

  test('a page smaller than its count is truncated', async () => {
    stubList({
      conversations: [row('a'), row('b')],
      counts: { open: 64, done: 0, all: 64 },
    });
    const list = await listConversations('project-1', 'open');
    expect(list.chats).toHaveLength(2);
    expect(list.truncated).toBe(true);
  });

  test('a page that holds everything is not truncated', async () => {
    stubList({
      conversations: [row('a'), row('b')],
      counts: { open: 2, done: 9, all: 11 },
    });
    const list = await listConversations('project-1', 'open');
    expect(list.truncated).toBe(false);
  });

  test('the scope reaches the server rather than being filtered here', async () => {
    // The route caps at 50-plus rows, so filtering in the browser would drop
    // chats off the end of the list without saying so.
    stubList({ conversations: [], counts: { open: 0, done: 0, all: 0 } });
    await listConversations('project-1', 'done');
    expect(requested[0]).toContain('state=done');
  });
});

describe('listAllConversations', () => {
  test('asks for every project and both lifecycle states in one read', async () => {
    stubList({ conversations: [], counts: { open: 0, done: 0, all: 0 } });
    await listAllConversations();
    expect(requested).toHaveLength(1);
    expect(requested[0]).not.toContain('codebaseId');
    expect(requested[0]).toContain('state=all');
  });

  test("carries each chat's project and leaves out chats with none", async () => {
    // A chat outside every project has no page in the console to open on.
    stubList({
      conversations: [
        { ...row('a'), codebase_id: 'p1' },
        { ...row('b'), codebase_id: null },
      ],
      counts: { open: 2, done: 0, all: 2 },
    });
    const list = await listAllConversations();
    expect(list.chats.map(f => [f.chat.id, f.projectId])).toEqual([['a', 'p1']]);
    expect(list.truncated).toBe(false);
  });

  test('says when the cap cut the list short', async () => {
    stubList({
      conversations: [{ ...row('a'), codebase_id: 'p1' }],
      counts: { open: 300, done: 400, all: 700 },
    });
    expect((await listAllConversations()).truncated).toBe(true);
  });
});
