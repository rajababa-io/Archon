import { describe, expect, mock, test } from 'bun:test';

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

import type { NotifyPrefs, PushSubscriptionRecord } from '@archon/core/db/push';
import {
  SETTINGS_PATH,
  chatPath,
  runPath,
} from '../../../web/src/experiments/console/mobile/lib/paths';
import {
  PushNotifier,
  SETTINGS_LINK,
  chatLink,
  decidePush,
  resolveChatMode,
  runLink,
  type ChatRef,
  type PushNotifierDeps,
  type PushTrigger,
} from './push-notifier';
import { ChatPresence } from './push-presence';
import type { PushDelivery } from './web-push';

const prefs = (over: Partial<NotifyPrefs> = {}): NotifyPrefs => ({
  triggers: { awaiting: true, runFinished: true, runFailed: true },
  mutedProjects: [],
  conversations: {},
  ...over,
});

const chat: ChatRef = { platformId: 'web-1', projectId: 'p1', title: 'Fix the login bug' };
const nobodyLooking = (): boolean => false;

const ASK = [
  'Two ways to go.',
  '```ask',
  '{"questions":[{"title":"Ship it today?","options":[{"label":"Yes"}]}]}',
  '```',
].join('\n');

describe('resolveChatMode', () => {
  test('nothing set is default', () => {
    expect(resolveChatMode(prefs(), 'web-1', 'p1')).toBe('default');
  });

  test('a muted project silences its chats', () => {
    expect(resolveChatMode(prefs({ mutedProjects: ['p1'] }), 'web-1', 'p1')).toBe('muted');
    expect(resolveChatMode(prefs({ mutedProjects: ['p1'] }), 'web-2', 'p2')).toBe('default');
  });

  test("a chat's own mode beats its project's mute", () => {
    const p = prefs({ mutedProjects: ['p1'], conversations: { 'web-1': 'following' } });
    expect(resolveChatMode(p, 'web-1', 'p1')).toBe('following');
  });

  test('a run with no chat still answers to its project', () => {
    expect(resolveChatMode(prefs({ mutedProjects: ['p1'] }), null, 'p1')).toBe('muted');
    expect(resolveChatMode(prefs(), null, null)).toBe('default');
  });
});

describe('decidePush', () => {
  const question: PushTrigger = { kind: 'question', chat, question: 'Ship it today?' };
  const turn: PushTrigger = { kind: 'turn_finished', chat, line: 'Merged #12.\nCI is green.' };
  const finished: PushTrigger = {
    kind: 'run_finished',
    runId: 'run-9',
    workflow: 'deliver',
    chat,
    projectId: 'p1',
    line: 'Fix the login bug',
  };

  test('a question pushes, collapsing onto the chat, and opens the chat', () => {
    expect(decidePush(question, prefs(), nobodyLooking)).toEqual({
      title: 'Fix the login bug needs you',
      body: 'Ship it today?',
      tag: 'chat:web-1',
      path: '/m/c/web-1',
    });
  });

  test('every push about one chat shares a tag, and every push about one run shares another', () => {
    const following = prefs({ conversations: { 'web-1': 'following' } });
    expect(decidePush(turn, following, nobodyLooking)?.tag).toBe(
      decidePush(question, following, nobodyLooking)?.tag
    );
    const gate: PushTrigger = {
      kind: 'approval',
      runId: 'run-9',
      workflow: 'deliver',
      chat,
      message: 'Merge?',
    };
    const failed: PushTrigger = { ...finished, kind: 'run_failed', line: 'boom' };
    const tags = [gate, finished, failed].map(t => decidePush(t, prefs(), nobodyLooking)?.tag);
    expect(tags).toEqual(['run:run-9', 'run:run-9', 'run:run-9']);
  });

  test('a chat on screen in any console is not pushed about', () => {
    const presence = new ChatPresence(45_000, () => 1_000);
    presence.report('desk', 'web-1');
    const visible = (id: string): boolean => presence.isVisible(id);
    expect(decidePush(question, prefs(), visible)).toBeNull();
    expect(decidePush(finished, prefs(), visible)).toBeNull();
    // Another chat is not covered by it.
    expect(
      decidePush({ ...question, chat: { ...chat, platformId: 'web-2' } }, prefs(), visible)
    ).not.toBeNull();
  });

  test('a run with no chat is never suppressed by presence', () => {
    const chatless: PushTrigger = { ...finished, chat: null };
    expect(decidePush(chatless, prefs(), () => true)).not.toBeNull();
  });

  test('a finished turn pushes only for a followed chat', () => {
    expect(decidePush(turn, prefs(), nobodyLooking)).toBeNull();
    expect(
      decidePush(turn, prefs({ conversations: { 'web-1': 'following' } }), nobodyLooking)
    ).toEqual({
      title: 'Fix the login bug',
      body: 'Merged #12.',
      tag: 'chat:web-1',
      path: '/m/c/web-1',
    });
  });

  test('muting the chat or its project silences every kind', () => {
    for (const muted of [
      prefs({ conversations: { 'web-1': 'muted' } }),
      prefs({ mutedProjects: ['p1'] }),
    ]) {
      expect(decidePush(question, muted, nobodyLooking)).toBeNull();
      expect(decidePush(finished, muted, nobodyLooking)).toBeNull();
    }
  });

  test('a global trigger turned off stops its kind, unless the chat is followed', () => {
    const off = prefs({ triggers: { awaiting: false, runFinished: false, runFailed: true } });
    expect(decidePush(question, off, nobodyLooking)).toBeNull();
    expect(decidePush(finished, off, nobodyLooking)).toBeNull();
    expect(decidePush({ ...finished, kind: 'run_failed' }, off, nobodyLooking)).not.toBeNull();
    const followed = { ...off, conversations: { 'web-1': 'following' as const } };
    expect(decidePush(question, followed, nobodyLooking)).not.toBeNull();
    expect(decidePush(finished, followed, nobodyLooking)).not.toBeNull();
  });

  test('a run links to its run screen, and says which way it ended', () => {
    expect(decidePush(finished, prefs(), nobodyLooking)).toMatchObject({
      title: 'deliver finished',
      path: '/m/r/run-9',
    });
    expect(
      decidePush(
        { ...finished, kind: 'run_failed', line: 'node x failed\nstack…' },
        prefs(),
        () => false
      )
    ).toMatchObject({ title: 'deliver failed', body: 'node x failed' });
  });
});

describe('deep links', () => {
  test("match the phone shell's own routes", () => {
    for (const id of ['web-1790553506639-pzz3ne', 'a b/c', 'run-9']) {
      expect(chatLink(id)).toBe(chatPath(id));
      expect(runLink(id)).toBe(runPath(id));
    }
    expect(SETTINGS_LINK).toBe(SETTINGS_PATH);
  });
});

describe('PushNotifier', () => {
  const sub = (n: number): PushSubscriptionRecord => ({
    id: `s${String(n)}`,
    endpoint: `https://push.example/${String(n)}`,
    p256dh: 'k',
    auth: 'a',
    userAgent: null,
  });

  function harness(over: Partial<PushNotifierDeps> = {}): {
    notifier: PushNotifier;
    sent: string[];
    deleted: string[];
    delivered: string[];
  } {
    const sent: string[] = [];
    const deleted: string[] = [];
    const delivered: string[] = [];
    const outcomes: Record<string, PushDelivery> = {
      s1: { outcome: 'delivered' },
      s2: { outcome: 'gone', status: 410 },
      s3: { outcome: 'failed', status: 500, detail: 'down' },
    };
    const deps: PushNotifierDeps = {
      keys: { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:a@b.c' },
      presence: new ChatPresence(),
      readPrefs: async () => prefs(),
      listSubscriptions: async () => [sub(1), sub(2), sub(3)],
      deleteSubscription: async endpoint => {
        deleted.push(endpoint);
        return true;
      },
      markDelivered: async id => {
        delivered.push(id);
      },
      send: async (s, payload) => {
        sent.push(payload);
        return outcomes[s.id] ?? { outcome: 'delivered' };
      },
      findChat: async id => (id === 'web-1' ? { ...chat, completed: false, dbId: 'db-1' } : null),
      newestMessage: async () => ({ role: 'assistant', content: ASK }),
      findRun: async () => ({ workflow: 'deliver', projectId: 'p1', chat }),
      ...over,
    };
    return { notifier: new PushNotifier(deps), sent, deleted, delivered };
  }

  test('a turn ending on a question pushes it to every browser; gone ones are forgotten', async () => {
    const h = harness();
    await h.notifier.turnEnded('web-1');
    expect(h.sent).toHaveLength(3);
    expect(JSON.parse(h.sent[0] ?? '{}')).toMatchObject({
      body: 'Ship it today?',
      tag: 'chat:web-1',
    });
    expect(h.delivered).toEqual(['s1']);
    expect(h.deleted).toEqual(['https://push.example/2']);
  });

  test('a closed chat that ended on a question is not asking', async () => {
    const h = harness({
      findChat: async () => ({ ...chat, completed: true, dbId: 'db-1' }),
    });
    await h.notifier.turnEnded('web-1');
    expect(h.sent).toEqual([]);
  });

  test('a turn whose last word is the human pushes nothing', async () => {
    const h = harness({ newestMessage: async () => ({ role: 'user', content: 'thanks' }) });
    await h.notifier.turnEnded('web-1');
    expect(h.sent).toEqual([]);
  });

  test('a hidden or unknown conversation — a run worker — pushes nothing', async () => {
    const h = harness();
    await h.notifier.turnEnded('web-worker-1');
    expect(h.sent).toEqual([]);
  });

  test('run events push on a gate, a finish and a failure, and nothing else', async () => {
    const h = harness({ listSubscriptions: async () => [sub(1)] });
    await h.notifier.workflowEvent({
      type: 'node_started',
      runId: 'r',
      nodeId: 'n',
      nodeName: 'n',
    } as never);
    await h.notifier.workflowEvent({
      type: 'approval_pending',
      runId: 'r',
      nodeId: 'gate',
      message: 'Merge it?',
    });
    await h.notifier.workflowEvent({
      type: 'workflow_failed',
      runId: 'r',
      workflowName: 'deliver',
      error: 'tests red',
    });
    expect(h.sent.map(p => (JSON.parse(p) as { title: string }).title)).toEqual([
      'deliver needs your approval',
      'deliver failed',
    ]);
  });

  test('a sub-run (no run found) pushes nothing', async () => {
    const h = harness({ findRun: async () => null });
    await h.notifier.workflowEvent({
      type: 'workflow_completed',
      runId: 'child',
      workflowName: 'x',
      duration: 1,
    });
    expect(h.sent).toEqual([]);
  });

  test('without VAPID keys nothing is looked up or sent', async () => {
    let looked = false;
    const h = harness({
      keys: null,
      findChat: async () => {
        looked = true;
        return null;
      },
    });
    await h.notifier.turnEnded('web-1');
    expect(looked).toBe(false);
    expect(await h.notifier.deliver({ title: 't', body: 'b', tag: 't', path: '/m/' })).toEqual({
      delivered: 0,
      failed: 0,
      removed: 0,
    });
  });
});
