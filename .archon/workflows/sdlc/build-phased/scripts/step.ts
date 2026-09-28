/**
 * Record one attempt and decide the loop's next iteration.
 *
 * - green: the phase is done; advance, and stop once every staged phase is green.
 * - red on a first attempt: keep the attempt's own account as notes for the retry,
 *   and build the same phase again.
 * - red on the retry: stop. Later phases would build on a base that is not green.
 *
 * Bound inputs: INPUTS_GREEN ("true"/"false"), INPUTS_RED_CAUSE, INPUTS_SUMMARY —
 * implement's verdict for this attempt.
 */

import { writeFileSync } from 'node:fs';
import { artifactsDir, emit, text, trimmed } from '../../.shared/io.ts';
import { notesPath, readState, stagedCount, writeState } from './state.ts';

/** The attempt limit per phase: the first try and one retry. */
const MAX_ATTEMPTS = 2;

function main(): void {
  const green = trimmed(process.env.INPUTS_GREEN) === 'true';
  const redCause = trimmed(process.env.INPUTS_RED_CAUSE);
  const summary = text(process.env.INPUTS_SUMMARY);

  const artifacts = artifactsDir();
  const state = readState(artifacts);
  const index = state.next;
  const title = state.phases[index]?.title ?? `#${String(index + 1)}`;
  state.log.push({ phase: index + 1, attempt: state.attempt, green, red_cause: redCause, summary });

  if (green) {
    state.next = index + 1;
    state.attempt = 1;
  } else if (state.attempt < MAX_ATTEMPTS) {
    writeFileSync(
      notesPath(artifacts, index),
      `# Phase ${String(index + 1)} "${title}": attempt ${String(state.attempt)} ended red\n\n` +
        `Declared cause: ${redCause || '(none declared)'}\n\n${summary}\n`
    );
    state.attempt += 1;
  } else {
    state.stopped =
      `phase ${String(index + 1)} "${title}" was red on both attempts ` +
      `(cause: ${redCause || 'none declared'})`;
  }
  writeState(artifacts, state);

  const done = state.stopped !== '' || state.next >= stagedCount(state);
  emit({ next: done ? 'stop' : 'continue', completed: state.next, total: state.phases.length });
}

if (import.meta.main) main();
