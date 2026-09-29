import { describe, expect, test } from 'bun:test';
import type { DeployDrain, DeployStatus } from '../skills/activeChats';
import {
  parseDeployAnswer,
  parseDeployLog,
  parseProjectDeploy,
  type HostDeploy,
  type WorkflowDeploy,
} from '../skills/deploy';
import {
  blockedTitle,
  DEPLOY_LOG_LABEL,
  deployConfirm,
  deployProgress,
  deployProgressText,
  deployRowView,
  parkCountdown,
  turnedOnNotice,
  waitingFooter,
  waitingPillLabel,
} from './deploy-row';

const LIVE = 'a6dd05e0c1f2a3b4c5d6e7f8091a2b3c4d5e6f70';
const INCOMING = '86b91ff0aa11bb22cc33dd44ee55ff6677889900';
const NOW = Date.parse('2026-09-27T12:00:00Z');

const PRS = [
  { number: 161, title: 'AI nodes receive WORKFLOW_ID', url: 'https://github.com/x/y/pull/161' },
  { number: 160, title: 'Deploy parks running work', url: 'https://github.com/x/y/pull/160' },
  { number: 158, title: 'Slash menu remembers', url: 'https://github.com/x/y/pull/158' },
  { number: 155, title: 'Every chat image opens', url: 'https://github.com/x/y/pull/155' },
];

function deploy(overrides: Partial<HostDeploy> = {}): HostDeploy {
  return {
    method: 'archon-host',
    deployOnMerge: false,
    branch: 'deploy',
    live: { sha: LIVE, deployedAt: '2026-09-27T07:00:00Z' },
    waiting: null,
    waitingReason: null,
    status: { phase: 'idle' },
    cancellable: false,
    running: { chats: 0, workflows: 0 },
    canAct: true,
    ...overrides,
  };
}

describe('deployRowView — the mockup states', () => {
  test('1: on, nothing waiting — Live and the switch, nothing on the right', () => {
    const view = deployRowView(deploy({ deployOnMerge: true }), undefined, NOW);
    expect(view).toEqual({
      kind: 'idle',
      live: { sha: 'a6dd05e0', ago: 'deployed 5h ago' },
      deployOnMerge: true,
      right: { kind: 'none' },
      blocked: null,
    });
  });

  test('2: off, merged PRs waiting — the pill and Deploy now', () => {
    const waiting = { tipSha: INCOMING, prs: PRS, more: false };
    const view = deployRowView(deploy({ waiting }), undefined, NOW);
    expect(view.kind).toBe('idle');
    if (view.kind !== 'idle') return;
    expect(view.deployOnMerge).toBe(false);
    expect(view.right).toEqual({ kind: 'waiting', waiting, label: '4 merged PRs waiting' });
  });

  test('3: off, nothing waiting — Up to date', () => {
    const view = deployRowView(deploy(), undefined, NOW);
    expect(view.kind === 'idle' ? view.right : null).toEqual({ kind: 'up-to-date' });
  });

  test('3b: an unreadable waiting list is never shown as Up to date', () => {
    const view = deployRowView(deploy({ waitingReason: 'unreachable' }), undefined, NOW);
    expect(view.kind === 'idle' ? view.right : null).toEqual({
      kind: 'unknown',
      label: "Can't reach GitHub",
      reason: 'unreachable',
    });
  });

  test('4: a deploy in progress — Live keeps the live commit, the incoming one is in the progress', () => {
    const status: DeployStatus = { phase: 'draining', sha: INCOMING };
    const drain: DeployDrain = {
      holding: { activeConversations: 2, queuedMessages: 0, runningWorkflows: 0 },
      parkAt: new Date(NOW + (6 * 60 + 12) * 1000).toISOString(),
    };
    const view = deployRowView(deploy({ status, cancellable: true }), drain, NOW);
    expect(view).toEqual({
      kind: 'deploying',
      live: { sha: 'a6dd05e0', ago: null },
      progress: 'Deploying 86b91ff0 · waiting on 2 chats · pauses them in 6:12',
      fraction: 0.5,
      showCancel: true,
    });
  });

  test('4b: Cancel deploy is offered only when the server says it can land', () => {
    const view = deployRowView(deploy({ status: { phase: 'swapping' } }), undefined, NOW);
    expect(view.kind === 'deploying' ? view.showCancel : null).toBe(false);
  });

  test('5: a project with no deploy has no row — the GET answers null', () => {
    expect(parseProjectDeploy(null)).toBeNull();
  });
});

describe('pluralisation', () => {
  test('the pill', () => {
    expect(waitingPillLabel({ tipSha: INCOMING, prs: PRS.slice(0, 1), more: false })).toBe(
      '1 merged PR waiting'
    );
    expect(waitingPillLabel({ tipSha: INCOMING, prs: PRS, more: true })).toBe(
      '4+ merged PRs waiting'
    );
    expect(waitingPillLabel({ tipSha: INCOMING, prs: [], more: false })).toBe(
      'New commits waiting'
    );
  });

  test('the popover footer', () => {
    expect(waitingFooter({ tipSha: INCOMING, prs: PRS, more: false })).toBe(
      'Deploy now ships all 4 together.'
    );
    expect(waitingFooter({ tipSha: INCOMING, prs: PRS.slice(0, 1), more: false })).toBe(
      'Deploy now ships it.'
    );
  });

  test('the turned-on notice', () => {
    expect(turnedOnNotice(null)).toBeNull();
    expect(turnedOnNotice({ tipSha: INCOMING, prs: PRS, more: false })).toBe(
      '4 PRs will deploy on the next merge.'
    );
    expect(turnedOnNotice({ tipSha: INCOMING, prs: PRS.slice(0, 1), more: false })).toBe(
      '1 PR will deploy on the next merge.'
    );
  });

  test('the confirm drops zero parts and agrees in number', () => {
    expect(deployConfirm('Archon', { chats: 0, workflows: 0 })).toBeNull();
    expect(deployConfirm('Archon', { chats: 3, workflows: 1 })).toEqual({
      title: 'Deploy Archon now?',
      body:
        "3 chats and 1 workflow are running. They'll be paused and resumed automatically, " +
        'and each redoes only the step it was in. Archon is unavailable for about 4 minutes during the swap.',
    });
    expect(deployConfirm('Archon', { chats: 1, workflows: 0 })?.body).toStartWith(
      "1 chat is running. It'll be paused"
    );
    expect(deployConfirm('Archon', { chats: 0, workflows: 2 })?.body).toStartWith(
      '2 workflows are running.'
    );
  });

  test('the drain names workflows too, and drops the zero side', () => {
    const drain: DeployDrain = {
      holding: { activeConversations: 1, queuedMessages: 0, runningWorkflows: 2 },
    };
    expect(deployProgressText({ phase: 'draining' }, drain, NOW)).toBe(
      'Deploying · waiting on 1 chat and 2 workflows'
    );
  });
});

describe('parkCountdown', () => {
  test('counts down in m:ss', () => {
    expect(parkCountdown(new Date(NOW + 372_000).toISOString(), NOW)).toBe('6:12');
    expect(parkCountdown(new Date(NOW + 5_000).toISOString(), NOW)).toBe('0:05');
    expect(parkCountdown(new Date(NOW + 61 * 60_000).toISOString(), NOW)).toBe('61:00');
  });

  test('says nothing when absent, unreadable, or past', () => {
    expect(parkCountdown(undefined, NOW)).toBeNull();
    expect(parkCountdown('not a date', NOW)).toBeNull();
    expect(parkCountdown(new Date(NOW - 1_000).toISOString(), NOW)).toBeNull();
    expect(parkCountdown(new Date(NOW).toISOString(), NOW)).toBeNull();
  });

  test('a past park time drops the clause, not the rest', () => {
    const drain: DeployDrain = {
      holding: { activeConversations: 2, queuedMessages: 0, runningWorkflows: 0 },
      parkAt: new Date(NOW - 1_000).toISOString(),
    };
    expect(deployProgressText({ phase: 'draining', sha: INCOMING }, drain, NOW)).toBe(
      'Deploying 86b91ff0 · waiting on 2 chats'
    );
  });

  test('without the health drain block, falls back to the deploy holding sentence', () => {
    expect(
      deployProgressText({ phase: 'draining', holding: '1 chat mid-turn' }, undefined, NOW)
    ).toBe('Deploying · waiting on 1 chat mid-turn');
  });
});

describe('deployProgress', () => {
  test('places each phase in order, and building by its step', () => {
    expect(deployProgress({ phase: 'requested' })).toBeCloseTo(0.1);
    expect(
      deployProgress({ phase: 'building', step: { number: 1, of: 2, name: 'x' } })
    ).toBeCloseTo(0.25);
    expect(deployProgress({ phase: 'verifying' })).toBeCloseTo(0.9);
  });

  test('an unknown phase is not given a position', () => {
    expect(deployProgress({ phase: 'unknown' })).toBeNull();
  });
});

describe('parsing', () => {
  test('reads a full answer and drops malformed PRs', () => {
    const parsed = parseProjectDeploy({
      method: 'archon-host',
      deployOnMerge: true,
      branch: 'deploy',
      live: { sha: LIVE, deployedAt: null },
      waiting: { tipSha: INCOMING, prs: [PRS[0], { number: 'x' }], more: true },
      waitingReason: null,
      status: { phase: 'idle' },
      cancellable: false,
      running: { chats: 2, workflows: -1 },
      canAct: false,
    });
    expect(parsed?.waiting?.prs).toEqual([PRS[0]]);
    expect(parsed?.waiting?.more).toBe(true);
    expect(parsed?.method === 'archon-host' ? parsed.running : null).toEqual({
      chats: 2,
      workflows: 0,
    });
    expect(parsed?.canAct).toBe(false);
  });

  test('a status this build cannot read yields no row rather than a guessed one', () => {
    expect(
      parseProjectDeploy({
        method: 'archon-host',
        deployOnMerge: true,
        status: { phase: 'teleporting' },
      })
    ).toBeNull();
  });

  test('the log keeps known kinds only', () => {
    expect(
      parseDeployLog({
        entries: [
          { at: '2026-09-27T11:00:00Z', kind: 'ok', actor: null, sha: LIVE, detail: null },
          { at: '2026-09-27T10:00:00Z', kind: 'exploded' },
        ],
      })
    ).toEqual([{ at: '2026-09-27T11:00:00Z', kind: 'ok', actor: null, sha: LIVE, detail: null }]);
  });

  test('a merge that did not deploy keeps its reason and the merge that asked', () => {
    const entry = {
      at: '2026-09-27T12:00:00Z',
      kind: 'not_started' as const,
      actor: 'rajababa-io/atlas#12',
      sha: LIVE,
      detail: 'This project has no workflow named "deploy".',
    };
    expect(parseDeployLog({ entries: [entry] })).toEqual([entry]);
    expect(DEPLOY_LOG_LABEL.not_started).toBe("Merge didn't deploy");
  });

  test('a deploy following the deploy branch says so, never Up to date', () => {
    const view = deployRowView(
      deploy({ branch: 'deploy', waitingReason: 'branch-is-deploy-pointer' }),
      undefined,
      NOW
    );
    expect(view.kind === 'idle' ? view.right : null).toEqual({
      kind: 'unknown',
      label: 'Watching the deploy branch, not the one merges land on',
      reason: 'branch-is-deploy-pointer',
    });
  });
});

function workflowDeploy(overrides: Partial<WorkflowDeploy> = {}): WorkflowDeploy {
  return {
    method: 'workflow',
    workflowName: 'deploy',
    deployOnMerge: false,
    branch: 'main',
    live: { sha: LIVE, deployedAt: '2026-09-27T07:00:00Z' },
    waiting: null,
    waitingReason: null,
    cancellable: false,
    canAct: true,
    run: null,
    blocked: null,
    ...overrides,
  };
}

describe('deployRowView — a workflow deploy', () => {
  test('idle reads like the host deploy: Live, the switch, Up to date', () => {
    const view = deployRowView(workflowDeploy(), undefined, NOW);
    expect(view).toEqual({
      kind: 'idle',
      live: { sha: 'a6dd05e0', ago: 'deployed 5h ago' },
      deployOnMerge: false,
      right: { kind: 'up-to-date' },
      blocked: null,
    });
  });

  test('a run in flight is the deploy in progress, cancellable only while it runs', () => {
    const run = {
      id: 'r1',
      sha: INCOMING,
      status: 'running' as const,
      startedAt: '2026-09-27T11:59:00Z',
    };
    expect(deployRowView(workflowDeploy({ run, cancellable: true }), undefined, NOW)).toEqual({
      kind: 'deploying',
      live: { sha: 'a6dd05e0', ago: null },
      progress: 'Deploying 86b91ff0 · running',
      fraction: null,
      showCancel: true,
    });
    const pending = deployRowView(
      workflowDeploy({ run: { ...run, status: 'pending' } }),
      undefined,
      NOW
    );
    expect(pending.kind === 'deploying' ? pending.progress : null).toBe(
      'Deploying 86b91ff0 · starting'
    );
  });

  test('a missing workflow greys Deploy now and says why', () => {
    const view = deployRowView(
      workflowDeploy({ blocked: 'workflow-missing', workflowName: 'ship' }),
      undefined,
      NOW
    );
    expect(view.kind === 'idle' ? view.blocked : null).toBe(
      'This project has no workflow named "ship"'
    );
    expect(blockedTitle('no-trigger-host', 'ship')).toContain('ARCHON_TRIGGER_HOST');
  });
});

describe('parsing the GET answer', () => {
  test('no deploy is the not-set-up bar with the picker defaults', () => {
    expect(
      parseDeployAnswer({
        deploy: null,
        setup: { branch: 'main', workflows: ['build', 'deploy', 7], workflow: 'deploy' },
        canAct: true,
      })
    ).toEqual({
      kind: 'not-set-up',
      setup: { branch: 'main', workflows: ['build', 'deploy'], workflow: 'deploy' },
      canAct: true,
    });
  });

  test('a default the list does not hold is not pre-selected', () => {
    const answer = parseDeployAnswer({
      deploy: null,
      setup: { branch: null, workflows: ['build'], workflow: 'deploy' },
    });
    expect(answer?.kind === 'not-set-up' ? answer.setup : null).toEqual({
      branch: null,
      workflows: ['build'],
      workflow: null,
    });
  });

  test('a workflow deploy is read with its run and blocker', () => {
    const answer = parseDeployAnswer({
      deploy: {
        method: 'workflow',
        workflowName: 'deploy',
        deployOnMerge: false,
        branch: 'main',
        live: { sha: null, deployedAt: null },
        waiting: null,
        waitingReason: null,
        cancellable: true,
        canAct: true,
        run: { id: 'r1', sha: INCOMING, status: 'running', startedAt: '2026-09-27T11:59:00Z' },
        blocked: 'restarting',
      },
    });
    expect(answer?.kind === 'set-up' ? answer.deploy : null).toMatchObject({
      method: 'workflow',
      run: { id: 'r1', status: 'running' },
      blocked: 'restarting',
    });
  });

  test('a remote-host deploy reads as a bar with no in-flight state (#220)', () => {
    const answer = parseDeployAnswer({
      deploy: {
        method: 'remote-host',
        deployOnMerge: false,
        branch: 'main',
        live: { sha: 'a'.repeat(40), deployedAt: null },
        waiting: {
          tipSha: 'c'.repeat(40),
          prs: [{ number: 7, title: 'x', url: 'u' }],
          more: false,
        },
        waitingReason: null,
        cancellable: false,
        canAct: true,
      },
    });
    expect(answer?.kind).toBe('set-up');
    const deploy = answer?.kind === 'set-up' ? answer.deploy : null;
    expect(deploy?.method).toBe('remote-host');
    const view = deploy === null ? null : deployRowView(deploy, undefined, Date.now());
    expect(view).toMatchObject({
      kind: 'idle',
      right: { kind: 'waiting', label: '1 merged PR waiting' },
    });
  });

  test('a method this build does not know draws no bar', () => {
    expect(parseDeployAnswer({ deploy: { method: 'teleport', deployOnMerge: true } })).toBeNull();
  });
});
