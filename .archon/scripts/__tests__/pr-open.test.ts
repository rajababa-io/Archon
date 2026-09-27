/**
 * pr-open: a correction round starts only on a pull request that is still open.
 *
 * A human merged the pull request while delivery was still correcting it (#96).
 * The next round's review then declared no pull request against delivery's record
 * and failed the run at publish, after the whole round had been spent.
 */
import { describe, expect, it } from 'bun:test';
import {
  PR_URL,
  forgeOperation,
  forgePrRecord,
  runDeliverScript,
  type ScriptOptions,
  type ScriptRun,
} from './deliver-checks-harness';

const record = { INPUTS_PR: JSON.stringify(forgePrRecord({ url: PR_URL })) };
const check = (options: ScriptOptions = {}): ScriptRun =>
  runDeliverScript('pr-open', { ...options, inputs: { ...record, ...options.inputs } });

describe('pr-open', () => {
  it('lets the round start while the pull request is open', () => {
    const result = check({ gh: { pr: { state: 'OPEN' } } });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('is still open');
  });

  it.each([
    ['MERGED', 'merged'],
    ['CLOSED', 'closed'],
  ] as const)('stops the run when the pull request was %s outside it', (state, word) => {
    const result = check({ gh: { pr: { state } } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`was ${word} outside this run`);
    expect(result.stderr).toContain('Delivery stops here');
    // A read, never a write.
    expect(result.gh.some(call => call.includes('--method'))).toBe(false);
  });

  it('reads through the forge CLI only when selected', () => {
    const result = check({
      source: 'forge',
      forge: {
        kind: 'fake',
        response: forgeOperation('pr.view', {
          pr: forgePrRecord({ state: 'merged' }),
          title: 't',
          body: 'b',
        }),
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('was merged outside this run');
    expect(result.gh).toEqual([]);
  });

  it('refuses when the live state cannot be read, rather than correcting blind', () => {
    const result = check({ source: 'forge', forge: { kind: 'no-plugin' } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('pr-open:');
  });
});
