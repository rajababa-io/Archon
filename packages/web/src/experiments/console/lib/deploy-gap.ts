/**
 * What sits in the gap between the code map's `dev` and `deploy` lines (#349):
 * the merged changes not yet running, and the button that ships them.
 *
 * It is a second face on the deploy row, not a second deploy. Every state is
 * read from the same server answer through `deployRowView`, so the gap and the
 * row cannot disagree about whether a deploy is running, and Deploy is the same
 * `deployNow` call with the same waiting tip.
 *
 * "Deployed" is never claimed from the request being accepted. The gap says it
 * only once the server's Live commit — the build the running container reports
 * — is the commit that was shipped.
 */

import type { DeployDrain } from '../skills/activeChats';
import type { ProjectDeploy, WaitingPr } from '../skills/deploy';
import { deployRowView, plural } from './deploy-row';
import { shortSha } from './deploy-strip';

/** `Deploy 3 changes`, `Deploy 20+ changes`, `Deploy new commits`. */
export function deployGapLabel(prs: readonly WaitingPr[], more: boolean): string {
  // A tip with no PR behind it is a commit pushed straight to the branch.
  if (prs.length === 0 && !more) return 'Deploy new commits';
  if (more) return `Deploy ${String(prs.length)}+ changes`;
  return `Deploy ${plural(prs.length, 'change')}`;
}

/** What the gap draws. `hidden` draws nothing at all. */
export type DeployGapView =
  | { kind: 'hidden' }
  | {
      kind: 'behind';
      label: string;
      prs: readonly WaitingPr[];
      more: boolean;
      /** The tip Deploy ships, sent back so a branch that moved is refused. */
      tipSha: string;
      /** The button is greyed with this title: pressing it could not deploy. */
      blocked: string | null;
    }
  | {
      kind: 'deploying';
      /** The server has the request but nothing has started: no second press. */
      pending: boolean;
      progress: string;
      fraction: number | null;
    }
  | { kind: 'deployed'; sha: string }
  | { kind: 'not-live'; target: string; live: string | null };

/**
 * The gap for a project's deploy answer. `shipped` is the commit this page saw
 * a deploy carry, kept by the component across the deploy so the moment after
 * it can be told apart from an ordinary idle answer.
 */
export function deployGapView(
  deploy: ProjectDeploy | null,
  drain: DeployDrain | undefined,
  now: number,
  shipped: string | null
): DeployGapView {
  if (deploy === null) return { kind: 'hidden' };
  const row = deployRowView(deploy, drain, now);
  if (row.kind === 'deploying') {
    const pending =
      (deploy.method === 'archon-host' && deploy.status.phase === 'requested') ||
      (deploy.method === 'workflow' && deploy.run?.status === 'pending');
    return { kind: 'deploying', pending, progress: row.progress, fraction: row.fraction };
  }
  if (shipped !== null) {
    const live = deploy.live.sha;
    if (live !== null && sameCommit(live, shipped))
      return { kind: 'deployed', sha: shortSha(live) };
    return {
      kind: 'not-live',
      target: shortSha(shipped),
      live: live === null ? null : shortSha(live),
    };
  }
  if (row.right.kind !== 'waiting') return { kind: 'hidden' };
  const { waiting } = row.right;
  return {
    kind: 'behind',
    label: deployGapLabel(waiting.prs, waiting.more),
    prs: waiting.prs,
    more: waiting.more,
    tipSha: waiting.tipSha,
    blocked: row.blocked,
  };
}

/**
 * The commit a running deploy carries, or null when it is not deploying or
 * does not say. The component remembers it so the gap can check Live against
 * it once the deploy ends.
 */
export function deployingSha(deploy: ProjectDeploy | null): string | null {
  if (deploy === null) return null;
  if (deploy.method === 'workflow') return deploy.run?.sha ?? null;
  if (deploy.method === 'archon-host' && deploy.status.phase !== 'idle') {
    return deploy.status.sha ?? null;
  }
  return null;
}

/** Shas compare by prefix: the host reports a short one, GitHub a full one. */
function sameCommit(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}
