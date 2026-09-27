import { describe, expect, test } from 'bun:test';
import {
  isAccessRefusal,
  parseCompletedCheckRunHead,
  summarizeHeadChecks,
  summarizeWorkflowRuns,
} from './ci-checks';

const done = (name: string, conclusion = 'success') => ({
  name,
  status: 'completed',
  conclusion,
});

describe('summarizeHeadChecks', () => {
  test('every run and every suite with runs finished: complete, with each conclusion', () => {
    expect(
      summarizeHeadChecks(
        [{ status: 'completed', latest_check_runs_count: 2 }],
        [done('lint'), done('test', 'failure')]
      )
    ).toEqual({
      kind: 'complete',
      checks: [
        { name: 'lint', conclusion: 'success' },
        { name: 'test', conclusion: 'failure' },
      ],
    });
  });

  test('a run still going is pending', () => {
    expect(
      summarizeHeadChecks(
        [],
        [done('lint'), { name: 'test', status: 'in_progress', conclusion: null }]
      )
    ).toEqual({ kind: 'pending' });
  });

  test('no runs yet is pending, not passed', () => {
    expect(summarizeHeadChecks([], [])).toEqual({ kind: 'pending' });
  });

  // The `needs:` case: the only job with a run has finished, and the jobs that
  // depend on it have not been created yet. The suite is what knows.
  test('an open suite holds the answer at pending even when every run so far is done', () => {
    expect(
      summarizeHeadChecks([{ status: 'in_progress', latest_check_runs_count: 1 }], [done('build')])
    ).toEqual({ kind: 'pending' });
  });

  test('a queued suite with no runs is ignored — an App that never reports stays queued', () => {
    expect(
      summarizeHeadChecks(
        [
          { status: 'completed', latest_check_runs_count: 1 },
          { status: 'queued', latest_check_runs_count: 0 },
        ],
        [done('build')]
      ).kind
    ).toBe('complete');
  });
});

describe('summarizeWorkflowRuns', () => {
  test('every run finished: complete, with each conclusion', () => {
    expect(summarizeWorkflowRuns([done('CI'), done('Labels', 'failure')])).toEqual({
      kind: 'complete',
      checks: [
        { name: 'CI', conclusion: 'success' },
        { name: 'Labels', conclusion: 'failure' },
      ],
    });
  });

  test('a run still queued or running: pending', () => {
    expect(
      summarizeWorkflowRuns([done('CI'), { name: 'Labels', status: 'queued', conclusion: null }])
    ).toEqual({ kind: 'pending' });
  });

  test('no run yet: pending, not passed', () => {
    expect(summarizeWorkflowRuns([])).toEqual({ kind: 'pending' });
  });
});

describe('isAccessRefusal', () => {
  test('403 and 404 are refusals', () => {
    expect(isAccessRefusal({ status: 403 })).toBe(true);
    expect(isAccessRefusal({ status: 404 })).toBe(true);
  });

  test('server errors, rate limits and non-HTTP errors are not', () => {
    expect(isAccessRefusal({ status: 502 })).toBe(false);
    expect(isAccessRefusal({ status: 429 })).toBe(false);
    expect(isAccessRefusal(new Error('socket hang up'))).toBe(false);
  });
});

describe('parseCompletedCheckRunHead', () => {
  const SHA = 'd'.repeat(40);

  test('reads the repository and head commit of a completed run', () => {
    expect(
      parseCompletedCheckRunHead({
        action: 'completed',
        check_run: { head_sha: SHA, pull_requests: [] },
        repository: { full_name: 'o/r' },
      })
    ).toEqual({ repo: 'o/r', headSha: SHA });
  });

  test('a run with no pull request still counts — a push to a base branch has none', () => {
    expect(
      parseCompletedCheckRunHead({
        action: 'completed',
        check_run: { head_sha: SHA },
        repository: { full_name: 'o/r' },
      })
    ).not.toBeNull();
  });

  test.each([
    [
      'not completed',
      { action: 'created', check_run: { head_sha: SHA }, repository: { full_name: 'o/r' } },
    ],
    [
      'short sha',
      { action: 'completed', check_run: { head_sha: 'abc' }, repository: { full_name: 'o/r' } },
    ],
    ['no repository', { action: 'completed', check_run: { head_sha: SHA } }],
    ['not an object', 'completed'],
  ])('%s is not a head', (_label, value) => {
    expect(parseCompletedCheckRunHead(value)).toBeNull();
  });
});
