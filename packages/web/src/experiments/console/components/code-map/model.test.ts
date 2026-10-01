import { describe, expect, test } from 'bun:test';
import type { CodeMapResponse, DeployLogEntry, ProjectDeploy } from '../../skills';
import { STATE_COLOR, deriveChanges, deriveEnvironments, newlyMerged, stateDetail } from './model';

const NOW = Date.parse('2026-10-01T20:00:00Z');

function pull(
  number: number,
  checks: CodeMapResponse['open'][number]['checks']
): CodeMapResponse['open'][number] {
  return {
    number,
    title: `PR ${String(number)}`,
    url: `https://github.com/o/r/pull/${String(number)}`,
    branch: `b${String(number)}`,
    draft: false,
    updatedAt: '2026-10-01T19:00:00Z',
    checks,
  };
}

const MAP: CodeMapResponse = {
  base: 'dev',
  open: [
    pull(345, { state: 'running', total: 7, done: 4, failedName: null }),
    pull(347, { state: 'failed', total: 7, done: 7, failedName: 'lint' }),
  ],
  merged: [
    {
      number: 343,
      title: 'Ready to close',
      url: 'u343',
      branch: 'b343',
      mergedAt: '2026-10-01T18:00:00Z',
    },
    { number: 340, title: 'Old', url: 'u340', branch: 'b340', mergedAt: '2026-10-01T10:00:00Z' },
  ],
  branches: [{ branch: 'archon/thread-1', commits: 12, lastCommitAt: null }],
  repo: 'o/r',
  reason: null,
};

const DEPLOY: ProjectDeploy = {
  method: 'remote-host',
  deployOnMerge: false,
  branch: 'dev',
  live: { sha: 'c01b85a1c01b85a1c01b85a1c01b85a1c01b85a1', deployedAt: '2026-10-01T12:00:00Z' },
  waiting: {
    tipSha: 'tip',
    prs: [{ number: 343, title: 'Ready to close', url: 'u343' }],
    more: false,
  },
  waitingReason: null,
  cancellable: false,
  canAct: false,
};

describe('deriveChanges', () => {
  test('one CI run, one merged-not-live, one failed: violet, pink, red', () => {
    const changes = deriveChanges(MAP, DEPLOY);
    const byNumber = new Map(changes.map(c => [c.number, c]));
    expect(byNumber.get(345)?.state).toBe('ci-running');
    expect(byNumber.get(343)?.state).toBe('merged');
    expect(byNumber.get(347)?.state).toBe('ci-failed');
    expect(STATE_COLOR['ci-running']).toBe('var(--status-waiting)');
    expect(STATE_COLOR.merged).toBe('var(--status-ready)');
    expect(STATE_COLOR['ci-failed']).toBe('var(--error)');
  });

  test('a merge that went live before the running commit is not drawn', () => {
    expect(deriveChanges(MAP, DEPLOY).some(c => c.number === 340)).toBe(false);
  });

  test('merged after the live commit counts even before the waiting list catches up', () => {
    const lagging = { ...DEPLOY, waiting: null };
    expect(deriveChanges(MAP, lagging).find(c => c.number === 343)?.state).toBe('merged');
  });

  test('with no deploy, a merge leaves the map', () => {
    expect(deriveChanges(MAP, null).some(c => c.state === 'merged')).toBe(false);
  });

  test('pull requests in number order, so a line keeps its lane; branches after', () => {
    expect(deriveChanges(MAP, DEPLOY).map(c => c.key)).toEqual([
      'pr:343',
      'pr:345',
      'pr:347',
      'branch:archon/thread-1',
    ]);
  });
});

describe('deriveEnvironments', () => {
  test('the deploy line carries the running commit and the merged count', () => {
    const changes = deriveChanges(MAP, DEPLOY);
    expect(deriveEnvironments(DEPLOY, changes)).toEqual([
      {
        id: 'deploy',
        label: 'deploy',
        sha: DEPLOY.live.sha,
        since: DEPLOY.live.deployedAt,
        behind: 1,
        behindMore: false,
        lastFailure: null,
      },
    ]);
  });

  test('no deploy, no environment', () => {
    expect(deriveEnvironments(null, [])).toEqual([]);
  });

  test('a failed last attempt is named; a newer success clears it', () => {
    const failed: DeployLogEntry = {
      at: '2026-10-01T19:00:00Z',
      kind: 'failed',
      actor: null,
      sha: null,
      detail: null,
    };
    const ok: DeployLogEntry = { ...failed, at: '2026-10-01T19:30:00Z', kind: 'ok' };
    const started: DeployLogEntry = { ...failed, at: '2026-10-01T19:40:00Z', kind: 'started' };
    expect(deriveEnvironments(DEPLOY, [], [started, failed])[0]?.lastFailure).toEqual({
      label: 'Failed',
      at: failed.at,
    });
    expect(deriveEnvironments(DEPLOY, [], [ok, failed])[0]?.lastFailure).toBeNull();
  });
});

describe('stateDetail', () => {
  test('says where each change is', () => {
    const [merged, running, failed, coding] = deriveChanges(MAP, DEPLOY);
    expect(stateDetail(running!, NOW)).toBe('CI running · 4 of 7 checks');
    expect(stateDetail(failed!, NOW)).toBe('CI failed · lint');
    expect(stateDetail(merged!, NOW)).toBe('merged 2h ago · not live');
    expect(stateDetail(coding!, NOW)).toBe('coding · 12 commits');
  });
});

describe('newlyMerged', () => {
  test('an open line that is merged on the next read is the one to animate', () => {
    const open = deriveChanges({ ...MAP, merged: [] }, { ...DEPLOY, waiting: null });
    const after = deriveChanges(
      {
        ...MAP,
        open: MAP.open.filter(p => p.number !== 345),
        merged: [
          {
            number: 345,
            title: 'PR 345',
            url: 'u',
            branch: 'b345',
            mergedAt: '2026-10-01T19:59:00Z',
          },
        ],
      },
      DEPLOY
    );
    expect(newlyMerged(open, after)).toEqual(['pr:345']);
    expect(newlyMerged(after, after)).toEqual([]);
  });
});
