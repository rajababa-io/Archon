/**
 * The phase this loop iteration builds, and which attempt it is.
 *
 * Reads the build state only; `step` is the one node that advances it. Refuses an
 * iteration with nothing left to build, which means the loop's completion check and
 * the state disagree — a fault to surface, not a phase to invent.
 */

import { existsSync } from 'node:fs';
import { artifactsDir, emit, refuse } from '../../.shared/io.ts';
import { notesPath, readState, stagedCount } from './state.ts';

function main(): void {
  const artifacts = artifactsDir();
  const state = readState(artifacts);
  const phase = state.phases[state.next];
  if (state.stopped !== '' || phase === undefined || state.next >= stagedCount(state)) {
    refuse(
      `pick: nothing left to build (next=${String(state.next)}, ` +
        `staged=${String(stagedCount(state))}, stopped="${state.stopped}").`
    );
    return;
  }
  const notes = notesPath(artifacts, state.next);
  emit({
    number: state.next + 1,
    total: state.phases.length,
    title: phase.title,
    file: phase.file,
    attempt: state.attempt,
    notes: state.attempt > 1 && existsSync(notes) ? notes : '',
  });
}

if (import.meta.main) main();
