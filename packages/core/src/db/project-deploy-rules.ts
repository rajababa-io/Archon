/**
 * The parts of a project deploy that need no database: which event kinds are
 * stored, and which branch a deploy must never follow. Apart from
 * `project-deploy.ts` so a test that fakes the database still reads the real
 * rules instead of a copy of them.
 */
import type { ProjectDeploy } from './project-deploy';

/**
 * The console actions `remote_agent_deploy_events` stores. The table's shipped
 * CHECK constraint holds the same four. The deploy log's full list of entry
 * kinds is the server's `DEPLOY_LOG_KINDS`, built on this one.
 */
export const DEPLOY_EVENT_KINDS = [
  'toggle_on',
  'toggle_off',
  'deploy_requested',
  'deploy_cancelled',
] as const;
export type DeployEventKind = (typeof DEPLOY_EVENT_KINDS)[number];

/**
 * The branch `scripts/deploy-local.sh` moves to name the commit this install
 * runs (its `REMOTE_BRANCH`). It is a pointer with that one writer, never the
 * branch merges land on, so an `archon-host` row naming it would measure
 * "merged but not live" along the pointer itself and never list a merge (#234).
 * `project-deploy-rules.test.ts` holds this to the script's default.
 */
export const ARCHON_HOST_DEPLOY_POINTER = 'deploy';

/**
 * Whether the row names the host's deploy pointer as the branch merges land on.
 * Such a row is misconfigured, and every reader says so rather than showing a
 * list that is silently short. Only `archon-host` has the pointer: a project
 * deploying with its own workflow may well merge into a branch called `deploy`.
 */
export function namesDeployPointer(setting: ProjectDeploy): boolean {
  return setting.method === 'archon-host' && setting.branch === ARCHON_HOST_DEPLOY_POINTER;
}
