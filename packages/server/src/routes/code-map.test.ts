import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  isRefusedCheckDetail,
  readCodingBranches,
  resolveBase,
  toChecks,
  toPulls,
} from './code-map';

function rollup(
  state: string,
  nodes: unknown[],
  counts: { runs?: unknown[]; statuses?: unknown[] } = {}
): unknown {
  const contexts = {
    totalCount: nodes.length,
    checkRunCountsByState: counts.runs ?? [],
    statusContextCountsByState: counts.statuses ?? [],
    nodes,
  };
  return { commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts } } }] } };
}

describe('toChecks', () => {
  test('a head with no checks reads none, not passed', () => {
    expect(toChecks({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })).toEqual({
      state: 'none',
      total: 0,
      done: 0,
      failedName: null,
    });
  });

  test('counts finished checks from the per-state counts while the rollup is pending', () => {
    const raw = rollup(
      'PENDING',
      [
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null },
        { __typename: 'StatusContext', context: 'deploy/preview', state: 'SUCCESS' },
      ],
      {
        runs: [
          { state: 'SUCCESS', count: 1 },
          { state: 'IN_PROGRESS', count: 1 },
          { state: 'QUEUED', count: 0 },
        ],
        statuses: [
          { state: 'SUCCESS', count: 1 },
          { state: 'PENDING', count: 0 },
        ],
      }
    );
    expect(toChecks(raw as never)).toEqual({
      state: 'running',
      total: 3,
      done: 2,
      failedName: null,
    });
  });

  test('a failure names the failing check, from either kind of context', () => {
    const run = rollup('FAILURE', [
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
    ]);
    expect(toChecks(run as never).failedName).toBe('lint');
    const status = rollup('ERROR', [
      { __typename: 'StatusContext', context: 'ci/x', state: 'ERROR' },
    ]);
    expect(toChecks(status as never)).toMatchObject({ state: 'failed', failedName: 'ci/x' });
  });

  test('check-run nodes refused to the token still count, and name no failure', () => {
    // What a fine-grained token gets back (#379): every CheckRun node nulled,
    // the counts and the verdict intact.
    const raw = rollup('FAILURE', [null, null], {
      runs: [
        { state: 'SUCCESS', count: 1 },
        { state: 'FAILURE', count: 1 },
      ],
    });
    expect(toChecks(raw as never)).toEqual({
      state: 'failed',
      total: 2,
      done: 2,
      failedName: null,
    });
  });

  test('success is passed', () => {
    expect(toChecks(rollup('SUCCESS', []) as never).state).toBe('passed');
  });
});

describe('isRefusedCheckDetail', () => {
  const nodePath = [
    'repository',
    'open',
    'nodes',
    0,
    'commits',
    'nodes',
    0,
    'commit',
    'statusCheckRollup',
    'contexts',
    'nodes',
    3,
  ];

  test('a FORBIDDEN check-context node is the error the map draws without', () => {
    expect(isRefusedCheckDetail({ type: 'FORBIDDEN', path: nodePath })).toBe(true);
  });

  test('any other error still fails the read', () => {
    expect(isRefusedCheckDetail({ type: 'NOT_FOUND', path: nodePath })).toBe(false);
    expect(isRefusedCheckDetail({ type: 'FORBIDDEN', path: ['repository'] })).toBe(false);
    expect(isRefusedCheckDetail({ type: 'FORBIDDEN' })).toBe(false);
    expect(
      isRefusedCheckDetail({ type: 'FORBIDDEN', path: ['repository', 'open', 'contexts', 'nodes'] })
    ).toBe(false);
  });
});

const DATA = {
  repository: {
    defaultBranchRef: { name: 'main' },
    open: {
      nodes: [
        {
          number: 5,
          title: 'into dev',
          url: 'u5',
          headRefName: 'feat/a',
          baseRefName: 'dev',
          isDraft: true,
          updatedAt: 't',
          commits: { nodes: [] },
        },
        {
          number: 6,
          title: 'into main',
          url: 'u6',
          headRefName: 'feat/b',
          baseRefName: 'main',
          isDraft: false,
          updatedAt: 't',
          commits: { nodes: [] },
        },
      ],
    },
    merged: {
      nodes: [
        {
          number: 4,
          title: 'merged',
          url: 'u4',
          headRefName: 'feat/old',
          baseRefName: 'dev',
          mergedAt: '2026-10-01T00:00:00Z',
        },
        {
          number: 3,
          title: 'elsewhere',
          url: 'u3',
          headRefName: 'feat/else',
          baseRefName: 'main',
          mergedAt: '2026-10-01T00:00:00Z',
        },
      ],
    },
  },
};

describe('resolveBase', () => {
  test('the deploy branch wins over the repository default', () => {
    expect(resolveBase(DATA, 'dev')).toBe('dev');
    expect(resolveBase(DATA, null)).toBe('main');
    expect(resolveBase({}, null)).toBeNull();
  });
});

describe('toPulls', () => {
  test('keeps only pull requests into the trunk', () => {
    const { open, merged } = toPulls(DATA, 'dev');
    expect(open.map(p => p.number)).toEqual([5]);
    expect(open[0]).toMatchObject({ branch: 'feat/a', draft: true, checks: { state: 'none' } });
    expect(merged.map(p => p.number)).toEqual([4]);
  });

  test('every head a pull request speaks for is covered, whatever its base', () => {
    expect([...toPulls(DATA, 'dev').closedHeads].sort()).toEqual([
      'feat/a',
      'feat/b',
      'feat/else',
      'feat/old',
    ]);
  });
});

describe('readCodingBranches', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) removeTempTree(r);
  });

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }

  /** A repo whose `origin/dev` is the first commit, with branches off it. */
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'code-map-'));
    roots.push(dir);
    git(dir, 'init', '-q', '-b', 'dev');
    git(
      dir,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'base'
    );
    git(dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
    for (const b of ['work', 'covered', 'quiet']) {
      git(dir, 'branch', b);
      git(dir, 'checkout', '-q', b);
      git(
        dir,
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        b
      );
    }
    git(dir, 'branch', 'empty', 'origin/dev');
    return dir;
  }

  test('a recent branch with commits the remote trunk lacks, and no pull request', async () => {
    const dir = repo();
    const envs = [
      { branch_name: 'work', days_since_activity: '0.1' },
      { branch_name: 'covered', days_since_activity: 0 },
      { branch_name: 'quiet', days_since_activity: 3 },
      { branch_name: 'empty', days_since_activity: 0 },
      { branch_name: 'gone', days_since_activity: 0 },
    ];
    const out = await readCodingBranches(dir, 'dev', envs, new Set(['covered']));
    expect(out.map(b => [b.branch, b.commits])).toEqual([['work', 1]]);
    expect(out[0]?.lastCommitAt).not.toBeNull();
  });
});
