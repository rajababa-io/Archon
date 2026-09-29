import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const mockFindByMethod = mock(async (_m: string): Promise<unknown> => null);
const mockIsIssued = mock(async (_id: string, _sha: string): Promise<boolean> => false);
const mockRecordEvent = mock(async (..._args: unknown[]): Promise<string> => 'event-id');
mock.module('@archon/core/db/project-deploy', () => ({
  findProjectDeployByMethod: mockFindByMethod,
  isIssuedManualRequest: mockIsIssued,
  recordDeployEvent: mockRecordEvent,
  listDeployEvents: mock(async () => []),
}));
mock.module('../routes/github-issues', () => ({
  githubGraphQl: mock(async () => ({ reason: 'not-in-tests' })),
  isIssueReadFailure: (src: unknown) => typeof src === 'object' && src !== null && 'reason' in src,
  resolveIssueSource: mock(async () => ({ repo: null, reason: 'no-repository' })),
}));

import {
  cancelDeploy,
  decidePolicy,
  deployedAt,
  deployNow,
  getProjectDeployView,
  HISTORY_PAGE,
  isCancellable,
  waitingFromHistory,
} from './deploy-control';

const trackTempRoot = trackTempRoots();
const savedEnv = {
  ARCHON_HOME: process.env.ARCHON_HOME,
  ARCHON_DEPLOYED_SHA_FILE: process.env.ARCHON_DEPLOYED_SHA_FILE,
};
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const LIVE = 'a'.repeat(40);
const TIP = 'c'.repeat(40);
const MID = 'b'.repeat(40);

function history(
  nodes: { oid: string; pr?: { number: number; title: string; merged?: boolean } }[]
) {
  return {
    repository: {
      ref: {
        target: {
          oid: nodes[0]?.oid,
          history: {
            nodes: nodes.map(n => ({
              oid: n.oid,
              associatedPullRequests: {
                nodes: n.pr
                  ? [
                      {
                        number: n.pr.number,
                        title: n.pr.title,
                        url: `u/${n.pr.number}`,
                        merged: n.pr.merged ?? true,
                      },
                    ]
                  : [],
              },
            })),
          },
        },
      },
    },
  };
}

describe('waitingFromHistory', () => {
  test('lists the merged PRs between the tip and the live commit, newest first', () => {
    const waiting = waitingFromHistory(
      history([
        { oid: TIP, pr: { number: 161, title: 'newest' } },
        { oid: MID, pr: { number: 160, title: 'older' } },
        { oid: LIVE, pr: { number: 150, title: 'already live' } },
      ]),
      LIVE
    );
    expect(waiting).toEqual({
      tipSha: TIP,
      prs: [
        { number: 161, title: 'newest', url: 'u/161' },
        { number: 160, title: 'older', url: 'u/160' },
      ],
      more: false,
    });
  });

  test('nothing is waiting when the tip is what is live', () => {
    expect(waitingFromHistory(history([{ oid: LIVE }]), LIVE)).toEqual({
      tipSha: LIVE,
      prs: [],
      more: false,
    });
  });

  test('a PR that was opened but never merged is not counted', () => {
    const waiting = waitingFromHistory(
      history([{ oid: TIP, pr: { number: 9, title: 'x', merged: false } }, { oid: LIVE }]),
      LIVE
    );
    expect(waiting?.prs).toEqual([]);
  });

  test('says there is more when the live commit is past the page', () => {
    const waiting = waitingFromHistory(
      history([{ oid: TIP, pr: { number: 1, title: 'a' } }]),
      LIVE
    );
    expect(waiting?.more).toBe(true);
  });

  test('with nothing deployed yet, a history shorter than a page is all there is', () => {
    const waiting = waitingFromHistory(
      history([
        { oid: TIP, pr: { number: 2, title: 'b' } },
        { oid: MID, pr: { number: 1, title: 'a' } },
      ]),
      null
    );
    expect(waiting?.prs.map(pr => pr.number)).toEqual([2, 1]);
    expect(waiting?.more).toBe(false);
  });

  test('with nothing deployed yet, a full page says there is more', () => {
    const nodes = Array.from({ length: HISTORY_PAGE }, (_, i) => ({
      oid: i.toString(16).padStart(40, '0'),
    }));
    expect(waitingFromHistory(history(nodes), null)?.more).toBe(true);
  });

  test('a branch GitHub does not know is no answer, not an empty one', () => {
    expect(waitingFromHistory({ repository: { ref: null } }, LIVE)).toBeNull();
  });
});

describe('deployedAt', () => {
  test('is the newest OK for the live commit', () => {
    const text =
      `2026-09-27T01:00:00Z  OK ${LIVE}\n` +
      `2026-09-27T02:00:00Z  FAILED ${TIP} — exit 1\n` +
      `2026-09-27T03:00:00Z  OK ${LIVE}\n` +
      `2026-09-27T04:00:00Z  HELD ${TIP} — Deploy on Merge is off (merge)\n`;
    expect(deployedAt(text, LIVE)).toBe('2026-09-27T03:00:00Z');
  });

  test('is unknown when the live commit was never recorded as deployed', () => {
    expect(deployedAt(`2026-09-27T01:00:00Z  OK ${TIP}\n`, LIVE)).toBeNull();
  });
});

describe('decidePolicy', () => {
  const setting = (on: boolean) => ({
    codebaseId: 'p',
    method: 'archon-host',
    branch: 'dev',
    deployOnMerge: on,
  });
  const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';

  beforeEach(() => {
    mockFindByMethod.mockReset();
    mockIsIssued.mockReset();
  });

  test('a merge with the toggle off is held', async () => {
    mockFindByMethod.mockImplementation(async () => setting(false));
    expect(await decidePolicy({ source: 'merge', sha: TIP, request: undefined })).toBe(
      'hold:toggle-off'
    );
  });

  test('a merge with the toggle on runs', async () => {
    mockFindByMethod.mockImplementation(async () => setting(true));
    expect(await decidePolicy({ source: 'merge', sha: TIP, request: undefined })).toBe('run');
  });

  test('a manual request runs whatever the toggle says, if the console issued it', async () => {
    mockFindByMethod.mockImplementation(async () => setting(false));
    mockIsIssued.mockImplementation(async () => true);
    expect(await decidePolicy({ source: 'manual', sha: TIP, request: ID })).toBe('run');
    expect(mockIsIssued).toHaveBeenCalledWith(ID, TIP);
  });

  test('a manual request nobody pressed Deploy now for is held', async () => {
    mockFindByMethod.mockImplementation(async () => setting(true));
    mockIsIssued.mockImplementation(async () => false);
    expect(await decidePolicy({ source: 'manual', sha: TIP, request: ID })).toBe('hold:not-issued');
  });

  test('a malformed request id is held without asking the database', async () => {
    mockFindByMethod.mockImplementation(async () => setting(true));
    expect(await decidePolicy({ source: 'manual', sha: TIP, request: "x' OR 1=1" })).toBe(
      'hold:not-issued'
    );
    expect(mockIsIssued).not.toHaveBeenCalled();
  });

  test('no project carrying this deploy means held', async () => {
    mockFindByMethod.mockImplementation(async () => null);
    expect(await decidePolicy({ source: 'merge', sha: TIP, request: undefined })).toBe(
      'hold:no-project'
    );
  });
});

describe('cancelDeploy', () => {
  function dir(): string {
    return trackTempRoot(mkdtempSync(join(tmpdir(), 'deploy-control-')));
  }

  beforeEach(() => {
    mockRecordEvent.mockClear();
    process.env.ARCHON_DEPLOYED_SHA_FILE = join(tmpdir(), 'no-such-deployed-sha');
  });

  test('withdraws a request the host has not picked up, and records it as KILLED', async () => {
    const d = dir();
    writeFileSync(join(d, 'deploy-request'), `${TIP}\nmerge\n`);
    const result = await cancelDeploy(
      'p',
      'you@example.com',
      d,
      () => new Date('2026-09-27T05:00:00.123Z')
    );
    expect(result).toEqual({ ok: true, how: 'withdrawn' });
    expect(existsSync(join(d, 'deploy-request'))).toBe(false);
    expect(readFileSync(join(d, 'deploy-history'), 'utf8')).toBe(
      `2026-09-27T05:00:00Z  KILLED ${TIP} — cancelled from the console before it started; running unknown\n`
    );
    expect(mockRecordEvent).toHaveBeenCalledWith('p', 'deploy_cancelled', 'you@example.com', TIP);
  });

  test('signals a deploy that is building', async () => {
    const d = dir();
    writeFileSync(
      join(d, 'deploy-last.log'),
      `2026-09-27T05:00:00Z  request: ${TIP}\n── 4/7  Build  [05:01:00Z]\n`
    );
    expect(await cancelDeploy('p', 'you', d)).toEqual({ ok: true, how: 'signalled' });
    expect(readFileSync(join(d, 'deploy-cancel'), 'utf8')).toBe(`${TIP}\n`);
  });

  test('refuses once the swap has begun, and changes nothing', async () => {
    const d = dir();
    writeFileSync(
      join(d, 'deploy-last.log'),
      `2026-09-27T05:00:00Z  request: ${TIP}\n── 6/7  Restart and wait for health  [05:09:00Z]\n`
    );
    const result = await cancelDeploy('p', 'you', d);
    expect(result.ok).toBe(false);
    expect(existsSync(join(d, 'deploy-cancel'))).toBe(false);
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  test('only requested, building and draining can be cancelled', () => {
    expect(['requested', 'building', 'draining'].every(p => isCancellable(p as never))).toBe(true);
    expect(['swapping', 'verifying', 'idle', 'unknown'].some(p => isCancellable(p as never))).toBe(
      false
    );
  });
});

describe('deployNow', () => {
  const codebase = { id: 'p', default_cwd: '/src' } as never;
  const setting = { method: 'archon-host', branch: 'dev' } as never;

  test('records the request before writing it, and hands the script its id', async () => {
    const d = trackTempRoot(mkdtempSync(join(tmpdir(), 'deploy-now-')));
    process.env.ARCHON_HOME = d;
    mockRecordEvent.mockClear();
    const run = mock(async (_cmd: string[], env: Record<string, string>) => {
      expect(mockRecordEvent).toHaveBeenCalledTimes(1);
      expect(env.DEPLOY_REQUEST_ID).toBe('event-id');
      expect(env.EXPECT_SHA).toBe(TIP);
      expect(env.DEV_BRANCH).toBe('dev');
      return { code: 0, stderr: '' };
    });
    expect(await deployNow(codebase, setting, TIP, 'you', run)).toEqual({
      ok: true,
      requestId: 'event-id',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('a branch that moved since the person looked is a 409, not a deploy', async () => {
    const d = trackTempRoot(mkdtempSync(join(tmpdir(), 'deploy-now-')));
    process.env.ARCHON_HOME = d;
    const run = mock(async () => ({ code: 3, stderr: 'moved' }));
    const result = await deployNow(codebase, setting, TIP, 'you', run);
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  test('refuses while another deploy is requested', async () => {
    const d = trackTempRoot(mkdtempSync(join(tmpdir(), 'deploy-now-')));
    process.env.ARCHON_HOME = d;
    writeFileSync(join(d, 'deploy-request'), `${MID}\nmerge\n`);
    const run = mock(async () => ({ code: 0, stderr: '' }));
    const result = await deployNow(codebase, setting, TIP, 'you', run);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(run).not.toHaveBeenCalled();
  });

  test('a deploy that follows the deploy pointer is refused, and nothing is recorded', async () => {
    const d = trackTempRoot(mkdtempSync(join(tmpdir(), 'deploy-now-')));
    process.env.ARCHON_HOME = d;
    mockRecordEvent.mockClear();
    const run = mock(async () => ({ code: 0, stderr: '' }));
    const pointer = { method: 'archon-host', branch: 'deploy' } as never;
    const result = await deployNow(codebase, pointer, TIP, 'you', run);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(run).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });
});

describe('getProjectDeployView', () => {
  test('a row following the deploy pointer says so instead of listing a short waiting list', async () => {
    const d = trackTempRoot(mkdtempSync(join(tmpdir(), 'deploy-view-')));
    const shaFile = join(d, 'sha');
    writeFileSync(shaFile, `${LIVE}\n`);
    process.env.ARCHON_DEPLOYED_SHA_FILE = shaFile;
    const view = await getProjectDeployView(
      { id: 'p', default_cwd: '/src' } as never,
      { method: 'archon-host', branch: 'deploy', deployOnMerge: false } as never,
      d
    );
    expect(view.waiting).toBeNull();
    expect(view.waitingReason).toBe('branch-is-deploy-pointer');
  });
});
