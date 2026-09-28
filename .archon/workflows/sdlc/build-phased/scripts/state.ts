/**
 * The build state every node of archon-build-phased reads and advances.
 *
 * One JSON file in the run's artifact directory. It is the loop's memory across
 * iterations (which phase is next, which attempt this is) and the record `status`
 * and `outcome` report from, so a loop that fails outright still leaves a truthful
 * account of what landed.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Phase {
  readonly title: string;
  /** Absolute path of the file holding this phase's work order. */
  readonly file: string;
}

export interface Attempt {
  readonly phase: number;
  readonly attempt: number;
  readonly green: boolean;
  readonly red_cause: string;
  readonly summary: string;
}

export interface BuildState {
  readonly spec: string;
  readonly phases: readonly Phase[];
  /** Zero-based index of the phase the next iteration builds. */
  next: number;
  /** 1 on a phase's first attempt, 2 on its retry. */
  attempt: number;
  /** Why the loop stopped early; empty while it has not. */
  stopped: string;
  readonly log: Attempt[];
}

/** Phases the loop builds: every one but the last, which goes through delivery. */
export function stagedCount(state: BuildState): number {
  return state.phases.length - 1;
}

export function buildDir(artifacts: string): string {
  const dir = join(artifacts, 'build-phased');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function statePath(artifacts: string): string {
  return join(buildDir(artifacts), 'state.json');
}

export function readState(artifacts: string): BuildState {
  return JSON.parse(readFileSync(statePath(artifacts), 'utf8')) as BuildState;
}

export function writeState(artifacts: string, state: BuildState): void {
  writeFileSync(statePath(artifacts), `${JSON.stringify(state, null, 2)}\n`);
}

/** The notes a retry reads: the red attempt's own account of what failed. */
export function notesPath(artifacts: string, phaseIndex: number): string {
  return join(buildDir(artifacts), `phase-${String(phaseIndex + 1)}-attempt-1.md`);
}
