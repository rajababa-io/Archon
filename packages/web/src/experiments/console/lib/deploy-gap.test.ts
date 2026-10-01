import { describe, expect, test } from 'bun:test';
import type { HostDeploy, WorkflowDeploy } from '../skills/deploy';
import { changeLine, deployGapLabel, deployGapView, deployingSha } from './deploy-gap';

const LIVE = 'a9f3e21c1f2a3b4c5d6e7f8091a2b3c4d5e6f70a';
const TIP = 'c01b85a1aa11bb22cc33dd44ee55ff6677889900';
const NOW = Date.parse('2026-10-01T12:00:00Z');

const PRS = [
  { number: 343, title: 'Ready to close', url: 'https://github.com/x/y/pull/344' },
  { number: 341, title: 'Untitled chat fix', url: 'https://github.com/x/y/pull/342' },
  { number: 336, title: 'Card last', url: 'https://github.com/x/y/pull/340' },
];

function host(overrides: Partial<HostDeploy> = {}): HostDeploy {
  return {
    method: 'archon-host',
    deployOnMerge: false,
    branch: 'deploy',
    live: { sha: LIVE, deployedAt: '2026-10-01T09:00:00Z' },
    waiting: { tipSha: TIP, prs: PRS, more: false },
    waitingReason: null,
    status: { phase: 'idle' },
    cancellable: false,
    running: { chats: 0, workflows: 0 },
    canAct: true,
    ...overrides,
  };
}

function workflow(overrides: Partial<WorkflowDeploy> = {}): WorkflowDeploy {
  return {
    method: 'workflow',
    workflowName: 'deploy',
    productionBranch: null,
    workflows: ['deploy'],
    run: null,
    blocked: null,
    deployOnMerge: false,
    branch: 'main',
    live: { sha: LIVE, deployedAt: null },
    waiting: { tipSha: TIP, prs: PRS, more: false },
    waitingReason: null,
    cancellable: false,
    canAct: true,
    ...overrides,
  };
}

describe('deployGapLabel', () => {
  test('counts the merged changes', () => {
    expect(deployGapLabel(PRS, false)).toBe('Deploy 3 changes');
    expect(deployGapLabel(PRS.slice(0, 1), false)).toBe('Deploy 1 change');
  });
  test('a capped list says so', () => {
    expect(deployGapLabel(PRS, true)).toBe('Deploy 3+ changes');
  });
  test('commits with no PR behind them', () => {
    expect(deployGapLabel([], false)).toBe('Deploy new commits');
  });
});

describe('deployGapView', () => {
  test('3 merged changes behind: the button names and lists all 3', () => {
    expect(deployGapView(host(), undefined, NOW, null)).toEqual({
      kind: 'behind',
      label: 'Deploy 3 changes',
      prs: PRS,
      more: false,
      tipSha: TIP,
      blocked: null,
    });
  });

  test('no deploy set up: hidden', () => {
    expect(deployGapView(null, undefined, NOW, null)).toEqual({ kind: 'hidden' });
  });

  test('not behind: hidden', () => {
    expect(deployGapView(host({ waiting: null }), undefined, NOW, null)).toEqual({
      kind: 'hidden',
    });
  });

  test('waiting list unreadable: hidden, not a guess', () => {
    const d = host({ waiting: null, waitingReason: 'unreachable' });
    expect(deployGapView(d, undefined, NOW, null)).toEqual({ kind: 'hidden' });
  });

  test('a request already pending shows as pending, with no button', () => {
    const d = host({ status: { phase: 'requested', sha: TIP } });
    const view = deployGapView(d, undefined, NOW, null);
    expect(view.kind).toBe('deploying');
    if (view.kind !== 'deploying') return;
    expect(view.pending).toBe(true);
    expect(view.progress).toBe('Deploying c01b85a1 · requested');
  });

  test('waiting on a chat: progress names it, not pending', () => {
    const d = host({ status: { phase: 'draining', sha: TIP } });
    const view = deployGapView(
      d,
      { holding: { activeConversations: 1, queuedMessages: 0, runningWorkflows: 0 } },
      NOW,
      null
    );
    expect(view).toMatchObject({
      kind: 'deploying',
      pending: false,
      progress: 'Deploying c01b85a1 · waiting on 1 chat',
    });
  });

  test('building: progress and a fraction', () => {
    const d = host({
      status: { phase: 'building', sha: TIP, step: { number: 2, of: 5, name: 'image' } },
    });
    const view = deployGapView(d, undefined, NOW, null);
    expect(view).toMatchObject({
      kind: 'deploying',
      progress: 'Deploying c01b85a1 · building 2/5',
    });
    if (view.kind === 'deploying') expect(view.fraction).toBeGreaterThan(0);
  });

  test('a pending workflow run is pending', () => {
    const d = workflow({
      run: { id: 'r1', sha: TIP, status: 'pending', startedAt: '2026-10-01T11:59:00Z' },
    });
    expect(deployGapView(d, undefined, NOW, null)).toMatchObject({
      kind: 'deploying',
      pending: true,
    });
  });

  test('deployed only once Live is the shipped commit', () => {
    const landed = host({ live: { sha: TIP, deployedAt: null }, waiting: null });
    expect(deployGapView(landed, undefined, NOW, TIP)).toEqual({
      kind: 'deployed',
      sha: 'c01b85a1',
    });
  });

  test('a short host sha matches the full shipped one', () => {
    const landed = host({ live: { sha: 'c01b85a1', deployedAt: null }, waiting: null });
    expect(deployGapView(landed, undefined, NOW, TIP).kind).toBe('deployed');
  });

  test('a deploy that ended with the old Live is not called deployed', () => {
    expect(deployGapView(host(), undefined, NOW, TIP)).toEqual({
      kind: 'not-live',
      target: 'c01b85a1',
      live: 'a9f3e21c',
    });
  });

  test('blocked workflow deploy greys the button', () => {
    const view = deployGapView(workflow({ blocked: 'restarting' }), undefined, NOW, null);
    expect(view).toMatchObject({ kind: 'behind' });
    if (view.kind === 'behind') expect(view.blocked).not.toBeNull();
  });
});

describe('deployingSha', () => {
  test('the host deploy in flight', () => {
    expect(deployingSha(host({ status: { phase: 'building', sha: TIP } }))).toBe(TIP);
  });
  test('the workflow run in flight', () => {
    const d = workflow({
      run: { id: 'r1', sha: TIP, status: 'running', startedAt: '2026-10-01T11:59:00Z' },
    });
    expect(deployingSha(d)).toBe(TIP);
  });
  test('nothing in flight', () => {
    expect(deployingSha(host())).toBeNull();
    expect(deployingSha(null)).toBeNull();
  });
});

describe('changeLine', () => {
  test('a title that leads with its issue keeps only that number', () => {
    expect(changeLine({ number: 344, title: '#343 Ready to close', url: '' })).toBe(
      '#343 Ready to close'
    );
  });
  test('a plain title gets the PR number', () => {
    expect(changeLine({ number: 344, title: 'Ready to close', url: '' })).toBe(
      '#344 Ready to close'
    );
  });
});
