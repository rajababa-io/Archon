/**
 * The words and the shape of a project's deploy row (#211), worked out
 * separately from the markup so every state the mockup draws is testable.
 *
 * Two rules the row rests on:
 *
 * - The Live commit is always `live.sha` from the server. During a deploy the
 *   incoming commit is named in the progress text, never in the Live slot —
 *   Live changes only when the new version is actually up.
 * - "Up to date" is a claim, so it is made only when the server read the
 *   branch and found nothing. When it could not read it (`waitingReason`), the
 *   row says so instead of reading as current.
 */

import type { DeployDrain, DeployStatus } from '../skills/activeChats';
import type {
  DeployBlocked,
  DeployLogKind,
  DeployWaiting,
  HostDeploy,
  ProjectDeploy,
  WorkflowDeploy,
} from '../skills/deploy';
import { shortSha } from './deploy-strip';
import { relativeTime } from './format';

/** `1 chat`, `2 chats`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** Join counted parts, dropping the zero ones: `2 chats and 1 workflow`. Null when all are zero. */
function countedParts(parts: readonly [number, string][]): string | null {
  const shown = parts.filter(([n]) => n > 0).map(([n, noun]) => plural(n, noun));
  return shown.length === 0 ? null : shown.join(' and ');
}

/** The amber pill: `1 merged PR waiting`, `4 merged PRs waiting`, `20+ merged PRs waiting`. */
export function waitingPillLabel(waiting: DeployWaiting): string {
  const n = waiting.prs.length;
  // A tip with no PR behind it is a commit pushed straight to the branch.
  if (n === 0 && !waiting.more) return 'New commits waiting';
  if (waiting.more) return `${String(n)}+ merged PRs waiting`;
  return `${plural(n, 'merged PR')} waiting`;
}

/** The popover footer, beside its Deploy now button. */
export function waitingFooter(waiting: DeployWaiting): string {
  const n = waiting.prs.length;
  if (waiting.more) return 'Deploy now ships all of them together.';
  if (n <= 1) return 'Deploy now ships it.';
  return `Deploy now ships all ${String(n)} together.`;
}

/**
 * The line under the row after Deploy on Merge is turned on with work already
 * waiting — turning it on ships the NEXT merge, not what is already there.
 */
export function turnedOnNotice(waiting: DeployWaiting | null): string | null {
  if (waiting === null) return null;
  const n = waiting.prs.length;
  if (waiting.more) return `${String(n)}+ PRs will deploy on the next merge.`;
  if (n === 0) return 'The waiting commits will deploy on the next merge.';
  return n === 1
    ? '1 PR will deploy on the next merge.'
    : `${String(n)} PRs will deploy on the next merge.`;
}

/** Why the waiting list could not be read, as the row names it. */
export function waitingUnknownLabel(reason: string): string {
  switch (reason) {
    case 'unreachable':
      return "Can't reach GitHub";
    case 'no-token':
      return 'No GitHub token';
    case 'live-unknown':
      return 'Live commit unknown';
    default:
      return "Can't check for merged PRs";
  }
}

/**
 * Time until the drain pauses running chats, as `m:ss`. Null when the deploy
 * named no moment, or the moment has passed — a clock stuck at 0:00 reads as
 * broken, and past that point the pause is already happening.
 */
export function parkCountdown(parkAt: string | undefined, now: number): string | null {
  if (parkAt === undefined) return null;
  const at = Date.parse(parkAt);
  if (Number.isNaN(at)) return null;
  const seconds = Math.ceil((at - now) / 1000);
  if (seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m)}:${s.toString().padStart(2, '0')}`;
}

export interface DeployConfirm {
  title: string;
  body: string;
}

/**
 * The Deploy now confirmation, or null when nothing is running and the deploy
 * should start straight away. The confirm exists only because running work is
 * paused; with none, it would be a question with one answer.
 */
export function deployConfirm(
  projectName: string,
  running: HostDeploy['running']
): DeployConfirm | null {
  const what = countedParts([
    [running.chats, 'chat'],
    [running.workflows, 'workflow'],
  ]);
  if (what === null) return null;
  const one = running.chats + running.workflows === 1;
  const effect = one
    ? "It'll be paused and resumed automatically, and redoes only the step it was in."
    : "They'll be paused and resumed automatically, and each redoes only the step it was in.";
  return {
    title: `Deploy ${projectName} now?`,
    body: `${what} ${one ? 'is' : 'are'} running. ${effect} ${projectName} is unavailable for about 4 minutes during the swap.`,
  };
}

const IN_FLIGHT_ORDER: readonly DeployStatus['phase'][] = [
  'requested',
  'building',
  'draining',
  'swapping',
  'verifying',
];

/**
 * How far through its phases a deploy is, 0..1, for the thin bar. It is the
 * position in the sequence, not an estimate of time left — the building step
 * is the only one that reports sub-progress. Null for a phase this cannot
 * place, which the bar draws as indeterminate rather than invent a position.
 */
export function deployProgress(status: DeployStatus): number | null {
  const index = IN_FLIGHT_ORDER.indexOf(status.phase);
  if (index < 0) return null;
  const within =
    status.phase === 'building' && status.step !== undefined && status.step.of > 0
      ? (status.step.number - 0.5) / status.step.of
      : 0.5;
  return (index + Math.min(1, Math.max(0, within))) / IN_FLIGHT_ORDER.length;
}

/**
 * What the deploy is doing, after the incoming commit:
 * `Deploying 86b91ff0 · waiting on 2 chats · pauses them in 6:12`.
 */
export function deployProgressText(
  status: DeployStatus,
  drain: DeployDrain | undefined,
  now: number
): string {
  const parts = [status.sha === undefined ? 'Deploying' : `Deploying ${shortSha(status.sha)}`];
  switch (status.phase) {
    case 'requested':
      parts.push('requested');
      break;
    case 'building':
      parts.push(
        status.step === undefined
          ? 'building'
          : `building ${String(status.step.number)}/${String(status.step.of)}`
      );
      break;
    case 'draining': {
      const held =
        drain === undefined
          ? null
          : countedParts([
              [drain.holding.activeConversations, 'chat'],
              [drain.holding.runningWorkflows, 'workflow'],
            ]);
      if (held !== null) {
        parts.push(`waiting on ${held}`);
        const clock = parkCountdown(drain?.parkAt, now);
        if (clock !== null) parts.push(`pauses them in ${clock}`);
      } else if (status.holding !== undefined) {
        // The health drain block is absent or empty; the deploy's own
        // holding sentence is the next-best account of what it waits for.
        parts.push(`waiting on ${status.holding}`);
      } else {
        parts.push('finishing up');
      }
      break;
    }
    case 'swapping':
      parts.push('swapping');
      break;
    case 'verifying':
      parts.push('verifying');
      break;
    default:
      break;
  }
  return parts.join(' · ');
}

/**
 * A workflow deploy's progress: `Deploying 86b91ff0 · running`. The run
 * reports no steps the bar could place, so there is no fraction to draw.
 */
export function workflowProgressText(run: NonNullable<WorkflowDeploy['run']>): string {
  const state =
    run.status === 'pending' ? 'starting' : run.status === 'paused' ? 'paused' : 'running';
  return `Deploying ${shortSha(run.sha)} · ${state}`;
}

/** Why Deploy now is greyed, as its title says it. */
export function blockedTitle(blocked: DeployBlocked, workflowName: string): string {
  switch (blocked) {
    case 'no-trigger-host':
      return 'This server starts no workflow runs on its own: set ARCHON_TRIGGER_HOST to deploy with a workflow';
    case 'restarting':
      return 'Archon is restarting; deploy again once it is back';
    case 'workflow-missing':
      return `This project has no workflow named "${workflowName}"`;
  }
}

export interface LiveView {
  /** The commit that is live, shortened. Null when the server does not know it. */
  sha: string | null;
  /** `deployed 2h ago`. Null during a deploy, and when the time is unknown. */
  ago: string | null;
}

/** What sits at the right end of the row when no deploy is running. */
export type DeployRowRight =
  /** Work is waiting: the pill and Deploy now. */
  | { kind: 'waiting'; waiting: DeployWaiting; label: string }
  /** Deploy on Merge is off and the branch holds nothing newer. */
  | { kind: 'up-to-date' }
  /** The waiting list could not be read. */
  | { kind: 'unknown'; label: string; reason: string }
  /** Deploy on Merge is on and nothing is waiting: merges ship themselves. */
  | { kind: 'none' };

export type DeployRowView =
  | {
      kind: 'idle';
      live: LiveView;
      deployOnMerge: boolean;
      right: DeployRowRight;
      /** Deploy now is shown greyed with this title: pressing it could not deploy. */
      blocked: string | null;
    }
  | {
      kind: 'deploying';
      live: LiveView;
      progress: string;
      fraction: number | null;
      /** Cancel deploy is offered only while the server says a cancel can still land. */
      showCancel: boolean;
    };

export function deployRowView(
  deploy: ProjectDeploy,
  drain: DeployDrain | undefined,
  now: number
): DeployRowView {
  const sha = deploy.live.sha === null ? null : shortSha(deploy.live.sha);

  if (deploy.method === 'workflow' && deploy.run !== null) {
    return {
      kind: 'deploying',
      live: { sha, ago: null },
      progress: workflowProgressText(deploy.run),
      fraction: null,
      showCancel: deploy.cancellable,
    };
  }
  if (deploy.method === 'archon-host' && deploy.status.phase !== 'idle') {
    return {
      kind: 'deploying',
      live: { sha, ago: null },
      progress: deployProgressText(deploy.status, drain, now),
      fraction: deployProgress(deploy.status),
      showCancel: deploy.cancellable,
    };
  }

  const ago =
    deploy.live.deployedAt === null
      ? null
      : `deployed ${relativeTime(deploy.live.deployedAt, now)}`;
  let right: DeployRowRight;
  if (deploy.waiting !== null) {
    right = { kind: 'waiting', waiting: deploy.waiting, label: waitingPillLabel(deploy.waiting) };
  } else if (deploy.waitingReason !== null) {
    right = {
      kind: 'unknown',
      label: waitingUnknownLabel(deploy.waitingReason),
      reason: deploy.waitingReason,
    };
  } else {
    right = deploy.deployOnMerge ? { kind: 'none' } : { kind: 'up-to-date' };
  }
  const blocked =
    deploy.method === 'workflow' && deploy.blocked !== null
      ? blockedTitle(deploy.blocked, deploy.workflowName)
      : null;
  return { kind: 'idle', live: { sha, ago }, deployOnMerge: deploy.deployOnMerge, right, blocked };
}

/** The Live slot when no commit can be named. A workflow deploy may simply not have run yet. */
export function liveMissingLabel(deploy: ProjectDeploy): string {
  return deploy.method === 'workflow' ? 'not deployed yet' : 'unknown';
}

/** The title on every action while this browser cannot act. */
export const PERSON_ONLY_TITLE = 'Only a person signed in through Cloudflare Access can do this';

/** How the Overview tab's deploy log names each kind of entry. */
export const DEPLOY_LOG_LABEL: Record<DeployLogKind, string> = {
  toggle_on: 'Deploy on Merge turned on',
  toggle_off: 'Deploy on Merge turned off',
  deploy_requested: 'Deploy now pressed',
  deploy_cancelled: 'Cancel deploy pressed',
  started: 'Deploy started',
  held: 'Held',
  ok: 'Deployed',
  failed: 'Failed',
  refused: 'Refused',
  killed: 'Stopped',
};
