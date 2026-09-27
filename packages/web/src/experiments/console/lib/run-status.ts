/**
 * Run status values plus the class-map helpers that express them visually.
 * Mapped to the app's semantic oklch design tokens from packages/web/src/index.css
 * so the spike renders in-brand.
 *
 * Status classes are kept separate from accent/primary classes: a primary CTA
 * must never collide with the "running" signal.
 */
import type { Run } from '../primitives/run';

export type RunStatus = 'running' | 'paused' | 'failed' | 'completed' | 'cancelled';

export const statusLabel: Record<RunStatus, string> = {
  running: 'Running',
  paused: 'Waiting for approval',
  failed: 'Failed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/**
 * The word for a run's state, including the one the database cannot tell you.
 *
 * `stalled` is a judgement the caller makes — it needs the workflow's run
 * history to know what "too long" is, which this module has no business
 * fetching. See primitives/stalled.ts. Nothing here mutates the run: the row
 * stays `running`, only the word changes, and Abandon remains the action.
 */
export function runStatusLabel(run: Run, stalled = false): string {
  if (stalled && run.status === 'running') return 'Stalled';
  if (run.status !== 'paused' || run.wait == null) return statusLabel[run.status];
  if (run.wait.kind === 'attention') return 'Waiting for action';
  if (run.wait.kind === 'park') return 'Paused for a restart';
  return run.wait.kind === 'event' ? 'Waiting for event' : 'Waiting until scheduled time';
}

/**
 * Status → class mappings.
 *
 * Color discipline:
 *   running   → blue  (active; pulsing strip)
 *   paused    → amber (waiting for human; pulsing dot)
 *   failed    → red
 *   completed → green (execution reached completion; muted strip, no pulse)
 *   cancelled → grey  (muted, user-stopped)
 *
 * The running blue uses an ad-hoc arbitrary value because the spike's theme
 * introduces `--running` as a new token that isn't in the production
 * `@theme inline` map. Completed reuses the production `--success` (green)
 * at lower opacity so it signals lifecycle completion without replacing the
 * separate workflow-authored outcome.
 */
export const statusStripClass: Record<RunStatus, string> = {
  running:
    'bg-[color:var(--running)] shadow-[0_0_12px_color-mix(in_oklch,var(--running),transparent_60%)] animate-pulse',
  paused: 'bg-warning',
  failed: 'bg-error',
  completed: 'bg-success/40',
  cancelled: 'bg-text-tertiary/40',
};

/** A stalled run is not an error and not activity — it is an absence. Tertiary
 *  so it recedes rather than competing with the runs that are alive. */
export const STALLED_TEXT_CLASS = 'text-text-tertiary';

export const statusTextClass: Record<RunStatus, string> = {
  running: 'text-[color:var(--running)]',
  paused: 'text-warning',
  failed: 'text-error',
  completed: 'text-success/80',
  cancelled: 'text-text-tertiary',
};

export const statusDotClass: Record<RunStatus, string> = {
  // `live-mark` (rail.css) is the shared working mark — the same breathe and
  // radiating ring a working chat wears. A run executing right now and a chat
  // executing right now are the same news; they looked different only because
  // they were drawn in different files.
  running: 'bg-[color:var(--running)] live-mark',
  paused: 'bg-warning animate-pulse',
  failed: 'bg-error',
  completed: 'bg-success',
  cancelled: 'bg-text-tertiary/60',
};
