/**
 * Refuse to start a correction round on a pull request that is no longer open.
 *
 * Delivery's pull-request record is read once, when the PR opens, and every later
 * node trusts it. A human can merge or close the PR while the run is still
 * correcting it. Nothing downstream can do right by that: a fix pushes commits to
 * a branch no open PR carries, and the review that follows either reviews the
 * wrong target or disagrees with the record about which target it reviewed. This
 * node reads the live state at the round boundary, before the round spends
 * anything, and stops the run with what actually happened.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */

import { viewPr } from '../../.shared/pr.ts';
import { forgeSource, parsePrRecord } from '../../.shared/forge.ts';
import { note, refuse, text } from '../../.shared/io.ts';

try {
  const source = forgeSource(process.env.ARCHON_SDLC_FORGE);
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const live = viewPr(pr, source).pr;
  if (live.state !== 'open') {
    throw new Error(
      `${live.url} was ${live.state} outside this run, so there is no open pull request left to correct. ` +
        'Delivery stops here; the findings still open are in the canonical review comment and review/report.md.'
    );
  }
  note(`pr-open: ${live.url} is still open.`);
} catch (error) {
  refuse(`pr-open: ${error instanceof Error ? error.message : String(error)}`);
}
