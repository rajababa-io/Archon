/**
 * Push subscriptions and preferences against a real SQLite schema — the upsert
 * on endpoint, the boolean round-trip and "default removes the row" are what a
 * mock could not show.
 */
import { describe, test, expect, mock } from 'bun:test';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const push = await import('./push');

describe('push subscriptions', () => {
  test('subscribing again from the same browser replaces its keys, not the row', async () => {
    await push.savePushSubscription({
      endpoint: 'https://push.example/a',
      p256dh: 'k1',
      auth: 'a1',
      userAgent: 'Safari',
    });
    await push.savePushSubscription({
      endpoint: 'https://push.example/a',
      p256dh: 'k2',
      auth: 'a2',
      userAgent: 'Safari',
    });
    const all = await push.listPushSubscriptions();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ endpoint: 'https://push.example/a', p256dh: 'k2', auth: 'a2' });
  });

  test('a delivery is recorded and a delete forgets the endpoint', async () => {
    const [sub] = await push.listPushSubscriptions();
    if (sub === undefined) throw new Error('expected a subscription');
    await push.markPushDelivered(sub.id);
    const stamped = await db.query<{ last_success_at: string | null }>(
      'SELECT last_success_at FROM remote_agent_push_subscriptions WHERE id = $1',
      [sub.id]
    );
    expect(stamped.rows[0]?.last_success_at).not.toBeNull();
    expect(await push.deletePushSubscription('https://push.example/a')).toBe(true);
    expect(await push.deletePushSubscription('https://push.example/a')).toBe(false);
    expect(await push.listPushSubscriptions()).toEqual([]);
  });

  test('a browser keeps its id across re-subscribing, and removing by id removes only it', async () => {
    const save = (endpoint: string, userAgent: string): Promise<string> =>
      push.savePushSubscription({ endpoint, p256dh: 'k', auth: 'a', userAgent });
    const old = await save('https://push.example/old', 'iPhone');
    const fresh = await save('https://push.example/new', 'iPhone');
    expect(await save('https://push.example/old', 'iPhone')).toBe(old);
    expect(fresh).not.toBe(old);

    await push.markPushDelivered(fresh);
    const devices = await push.listPushDevices();
    expect(devices.map(d => d.id).sort()).toEqual([old, fresh].sort());
    const delivered = devices.find(d => d.id === fresh);
    expect(delivered?.userAgent).toBe('iPhone');
    expect(delivered?.createdAt).toEqual(expect.any(String));
    expect(delivered?.lastSuccessAt).toEqual(expect.any(String));
    expect(devices.find(d => d.id === old)?.lastSuccessAt).toBeNull();
    expect(devices[0]).not.toHaveProperty('endpoint');

    expect(await push.deletePushSubscriptionById(old)).toBe(true);
    expect(await push.deletePushSubscriptionById(old)).toBe(false);
    expect((await push.listPushDevices()).map(d => d.id)).toEqual([fresh]);
    await push.deletePushSubscriptionById(fresh);
  });
});

describe('notify prefs', () => {
  test('with nothing stored, every trigger is on and nothing is muted', async () => {
    expect(await push.readNotifyPrefs()).toEqual({
      triggers: { awaiting: true, runFinished: true, runFailed: true },
      mutedProjects: [],
      conversations: {},
    });
  });

  test('a trigger turned off stays off, and the others keep their value', async () => {
    await push.setNotifyTriggers({ runFinished: false });
    await push.setNotifyTriggers({ runFailed: false });
    await push.setNotifyTriggers({ runFailed: true });
    expect((await push.readNotifyPrefs()).triggers).toEqual({
      awaiting: true,
      runFinished: false,
      runFailed: true,
    });
  });

  test('two changes to different triggers at once both land', async () => {
    await push.setNotifyTriggers({ awaiting: true, runFinished: true, runFailed: true });
    await Promise.all([
      push.setNotifyTriggers({ awaiting: false }),
      push.setNotifyTriggers({ runFinished: false }),
    ]);
    expect((await push.readNotifyPrefs()).triggers).toEqual({
      awaiting: false,
      runFinished: false,
      runFailed: true,
    });
    await push.setNotifyTriggers({ awaiting: true, runFinished: true });
  });

  test('modes are stored per scope, and default removes the row', async () => {
    await push.setNotifyMode({ scope: 'project', id: 'p1', mode: 'muted' });
    await push.setNotifyMode({ scope: 'conversation', id: 'web-1', mode: 'following' });
    await push.setNotifyMode({ scope: 'conversation', id: 'web-2', mode: 'muted' });
    await push.setNotifyMode({ scope: 'conversation', id: 'web-2', mode: 'default' });
    const prefs = await push.readNotifyPrefs();
    expect(prefs.mutedProjects).toEqual(['p1']);
    expect(prefs.conversations).toEqual({ 'web-1': 'following' });
    const rows = await db.query<{ scope_id: string }>(
      "SELECT scope_id FROM remote_agent_notify_prefs WHERE scope = 'conversation'"
    );
    expect(rows.rows.map(r => r.scope_id)).toEqual(['web-1']);
  });
});
