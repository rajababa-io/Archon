/**
 * A project that deploys itself on another host (#220). What is live comes only
 * from that host's reports; Deploy now refuses a branch that moved, and asks the
 * host only after the token it will present back has been recorded.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
  }),
}));

import type { DeployReport } from '@archon/core/db/project-deploy';

const PROJECT = 'b3a1f0c2-1111-4222-8333-444455556666';
const LIVE = 'a'.repeat(40);
const TIP = 'c'.repeat(40);
const OLD = 'b'.repeat(40);

const order: string[] = [];
const mockReports = mock(async (_id: string, _limit?: number): Promise<DeployReport[]> => []);
const mockEvents = mock(async (_id: string, _limit?: number): Promise<unknown[]> => []);
const mockRecordEvent = mock(async (..._args: unknown[]): Promise<string> => {
  order.push('record');
  return 'request-1';
});
mock.module('@archon/core/db/project-deploy', () => ({
  listDeployReports: mockReports,
  listDeployEvents: mockEvents,
  recordDeployEvent: mockRecordEvent,
}));

const mockReadWaiting = mock(
  async (
    _c: unknown,
    _branch: string,
    _live: string | null
  ): Promise<{ waiting: unknown; reason: string | null }> => ({
    waiting: { tipSha: TIP, prs: [{ number: 7, title: 'x', url: 'u' }], more: false },
    reason: null,
  })
);
mock.module('./deploy-control', () => ({
  readWaiting: mockReadWaiting,
  resetWaitingCache: () => undefined,
}));

const { deployRemoteNow, getRemoteDeployLog, getRemoteDeployView, liveFromReports } =
  await import('./remote-deploy');

const CODEBASE = { id: PROJECT, name: 'vault', default_cwd: '/vault' } as never;
const SETTING = {
  codebaseId: PROJECT,
  method: 'remote-host' as const,
  branch: 'main',
  productionBranch: null,
  deployOnMerge: false,
  updatedAt: '2026-09-29T00:00:00Z',
  updatedBy: null,
  remoteUrl: 'http://adina:8080/archon/deploy',
};

function report(verdict: DeployReport['verdict'], sha: string, liveSha: string, at: string) {
  return { verdict, sha, liveSha, reason: null, at };
}

beforeEach(() => {
  order.length = 0;
  mockReports.mockReset();
  mockReports.mockImplementation(async () => []);
  mockRecordEvent.mockClear();
  mockReadWaiting.mockClear();
});

describe('what is live', () => {
  test("is the newest report's running commit, deployed when its ok said", () => {
    expect(
      liveFromReports([
        report('held', TIP, LIVE, '2026-09-29T02:00:00Z'),
        report('ok', LIVE, LIVE, '2026-09-29T01:00:00Z'),
        report('ok', OLD, OLD, '2026-09-28T01:00:00Z'),
      ])
    ).toEqual({ sha: LIVE, deployedAt: '2026-09-29T01:00:00Z' });
  });

  test('is unknown before the host has reported anything', () => {
    expect(liveFromReports([])).toEqual({ sha: null, deployedAt: null });
  });

  test('with no report, the bar says so rather than calling the whole branch waiting', async () => {
    const view = await getRemoteDeployView(CODEBASE, SETTING);
    expect(view.waiting).toBeNull();
    expect(view.waitingReason).toBe('live-unknown');
    expect(mockReadWaiting).not.toHaveBeenCalled();
  });

  test('a held merge shows as waiting since the live commit', async () => {
    mockReports.mockImplementation(async () => [report('held', TIP, LIVE, '2026-09-29T02:00:00Z')]);
    const view = await getRemoteDeployView(CODEBASE, SETTING);
    expect(mockReadWaiting.mock.calls[0]?.[2]).toBe(LIVE);
    expect(view.live.sha).toBe(LIVE);
    expect(view.waiting?.prs).toHaveLength(1);
    expect(view.cancellable).toBe(false);
  });
});

describe('Deploy now', () => {
  test('records the token, then asks the host with it', async () => {
    const call = mock(async (_url: string, _body: unknown): Promise<number> => {
      order.push('call');
      return 202;
    });
    const result = await deployRemoteNow(CODEBASE, SETTING, TIP, 'you@example.com', call);
    expect(result).toEqual({ ok: true, requestId: 'request-1' });
    expect(order).toEqual(['record', 'call']);
    expect(mockRecordEvent).toHaveBeenCalledWith(
      PROJECT,
      'deploy_requested',
      'you@example.com',
      TIP
    );
    expect(call).toHaveBeenCalledWith(SETTING.remoteUrl, { sha: TIP, request: 'request-1' });
  });

  test('refuses a branch that moved, and asks nobody', async () => {
    const call = mock(async (): Promise<number> => 202);
    const result = await deployRemoteNow(CODEBASE, SETTING, OLD, 'you', call);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  test('a host that cannot be reached is an error the person sees', async () => {
    const call = mock(async (): Promise<number> => {
      throw new Error('connect ECONNREFUSED');
    });
    const result = await deployRemoteNow(CODEBASE, SETTING, TIP, 'you', call);
    expect(result).toMatchObject({ ok: false, status: 502 });
  });

  test('a host that refuses is an error the person sees', async () => {
    const result = await deployRemoteNow(CODEBASE, SETTING, TIP, 'you', async () => 500);
    expect(result).toMatchObject({ ok: false, status: 502 });
  });
});

describe('the log', () => {
  test("merges the console's presses with the host's reports, newest first", async () => {
    mockEvents.mockImplementationOnce(async () => [
      { at: '2026-09-29T03:00:00Z', kind: 'deploy_requested', actor: 'you', sha: TIP },
    ]);
    mockReports.mockImplementation(async () => [
      { ...report('ok', TIP, TIP, '2026-09-29T03:00:05Z') },
      { ...report('held', TIP, LIVE, '2026-09-29T02:00:00Z'), reason: 'hold:toggle-off' },
    ]);
    const log = await getRemoteDeployLog(PROJECT);
    expect(log.map(e => e.kind)).toEqual(['ok', 'deploy_requested', 'held']);
    expect(log[2]?.detail).toBe('hold:toggle-off');
  });
});
