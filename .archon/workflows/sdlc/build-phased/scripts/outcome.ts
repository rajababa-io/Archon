/**
 * The morning report: what landed, where it stopped, and the PR to look at.
 *
 * `complete` is this workflow's authored outcome — true only when the final phase
 * went through delivery and came back with the flipped PR's URL. A stopped build is
 * a completed run that did not finish the spec, and says so.
 *
 * Bound inputs: INPUTS_DELIVERED (deliver's flipped PR URL, or "null" when delivery
 * did not run) and INPUTS_DRAFT (the draft PR's URL, or "null").
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { buildDir, readState } from './state.ts';

function main(): void {
  const delivered = text(process.env.INPUTS_DELIVERED) || 'null';
  const draft = text(process.env.INPUTS_DRAFT) || 'null';
  const artifacts = artifactsDir();
  const state = readState(artifacts);
  const total = state.phases.length;
  const complete = delivered !== 'null';

  const lines: string[] = [];
  if (complete) {
    lines.push(`All ${String(total)} phases of ${state.spec} built and delivered: ${delivered}`);
  } else if (draft !== 'null') {
    lines.push(
      `Stopped after ${String(state.next)} of ${String(total)} phases: ${state.stopped}.`,
      `What landed green is up as a draft: ${draft}`
    );
  } else {
    lines.push(`Nothing landed: ${state.stopped || 'no phase completed'}.`);
  }
  lines.push('', 'Phases:');
  state.phases.forEach((p, i) => {
    const attempts = state.log.filter(a => a.phase === i + 1);
    const mark = i < state.next || (complete && i === total - 1) ? 'green' : attempts.length ? 'red' : 'not built';
    const tries = attempts.length > 1 ? ` (${String(attempts.length)} attempts)` : '';
    lines.push(`  ${String(i + 1)}. ${p.title} — ${mark}${tries}`);
  });
  const summary = lines.join('\n');
  writeFileSync(join(buildDir(artifacts), 'report.md'), `${summary}\n`);
  emit({ complete, summary });
}

if (import.meta.main) main();
