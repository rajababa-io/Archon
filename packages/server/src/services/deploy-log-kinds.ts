/**
 * Every kind of entry the Overview deploy log can hold — the one list (#235).
 * The log route's response schema is built from it, so the console reads it
 * through the generated API types rather than a copy.
 *
 * - the console's stored actions (`DEPLOY_EVENT_KINDS`);
 * - `started`: a workflow deploy's run began;
 * - `not_started`: a merge should have started a workflow deploy and did not;
 * - the verdicts, lowercased: the host's `deploy-history` words, or a workflow
 *   run's terminal status. `fromAttempt` in `deploy-control.ts` fails to
 *   type-check if a verdict is added there and not here.
 *
 * A module of its own so the route schema can import it while tests fake
 * `deploy-control.ts`.
 */
import { DEPLOY_EVENT_KINDS } from '@archon/core/db/project-deploy-rules';

export const DEPLOY_LOG_KINDS = [
  ...DEPLOY_EVENT_KINDS,
  'started',
  'not_started',
  'held',
  'ok',
  'failed',
  'refused',
  'killed',
] as const;
export type DeployLogKind = (typeof DEPLOY_LOG_KINDS)[number];
