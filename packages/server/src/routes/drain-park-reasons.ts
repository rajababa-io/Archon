/**
 * Why a deploy's park left something running, in a module of its own so the
 * deploy can explain it.
 *
 * Apart from `services/deploy-park.ts` for the reason `drain-budget.ts` is apart
 * from the drain route: `scripts/drain-wait.ts` prints these to the deploy log,
 * and importing the service would drag `@archon/core` into the scripts TypeScript
 * project. The server derives its reason type from these keys, so a reason the
 * park can report always has words the deploy can print.
 */
export const PARK_BLOCK_REASONS = {
  platform_cannot_resume: 'its chat platform has no way to resume it after the restart',
  no_conversation_record: 'no saved conversation matches it, so there is nothing to resume',
  unparkable_queued_turn: 'a message queued behind it cannot be saved for later',
  persist_failed: 'saving it for later failed',
  not_owned_by_this_server: 'this server does not run it',
  child_run: 'it is a sub-run; its parent decides',
  has_live_child_run: 'it has a sub-run still going',
  container_isolation: 'it runs in a container the server cannot resume',
  no_working_path: 'it has no working directory to resume in',
  park_failed: 'pausing it failed',
} as const;

export type ParkBlockReason = keyof typeof PARK_BLOCK_REASONS;
