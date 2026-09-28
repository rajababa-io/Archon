/**
 * Where the staged build ended, read from the recorded state.
 *
 * Runs after the loop however it ended — converged, stopped on a second red, failed
 * outright, or skipped because the spec has a single phase — which is why it reads
 * the state file rather than binding the loop's output.
 *
 * `ready` means every staged phase is green, so the last phase may go through
 * delivery. `has_work` means at least one phase landed, so a stopped build still
 * has something to hand over as a draft.
 */

import { artifactsDir, emit } from '../../.shared/io.ts';
import { readState, stagedCount } from './state.ts';

function main(): void {
  const state = readState(artifactsDir());
  const staged = stagedCount(state);
  const ready = state.stopped === '' && state.next >= staged;
  let stopped = state.stopped;
  if (!ready && stopped === '') {
    const last = state.log[state.log.length - 1];
    stopped =
      `the loop ended without finishing phase ${String(state.next + 1)} ` +
      `"${state.phases[state.next]?.title ?? ''}"` +
      (last === undefined ? ' (it failed before recording an attempt)' : ' (it failed outright)') +
      ' — the run record names the node that failed';
  }
  emit({ ready, has_work: state.next > 0, completed: state.next, total: state.phases.length, stopped });
}

if (import.meta.main) main();
