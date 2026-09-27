/**
 * Tests for the deploy-status reader.
 *
 * The fixtures here are the real shapes, copied from `/.archon/deploy-history` and
 * `/.archon/deploy-last.log` on the box that produces them, escape codes and all.
 * That matters more than usual: the whole module is a reader of text it does not
 * own, so a fixture invented to match the parser proves nothing.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  DEPLOY_STEP_COUNT,
  type DeployFileContents,
  deriveDeployStatus,
  parseDeployLog,
  parseLastAttempt,
  readDeployFiles,
  stripAnsi,
} from './deploy-status';

const ESC = '\u001B';
const BOLD = `${ESC}[1m`;
const RED = `${ESC}[31m`;
const RESET = `${ESC}[0m`;

const SHA = '92b597234d5505fc98e71f2a7fd0aa3ea153f7fe';
const OTHER_SHA = '15ffcc709acbd06f45fd900c36edcbd7c8c46b3e';

/** The seven steps, exactly as `step()` in `scripts/deploy-local.sh` names them. */
const STEPS: readonly string[] = [
  '1/7  Preflight',
  `2/7  Confirm fork/deploy has ${SHA}`,
  '3/7  Pull into /opt/archon',
  '4/7  Build',
  '5/7  Wait for the box to hold nothing',
  '6/7  Restart and wait for health',
  '7/7  Verify what is actually running',
];

function stepMarker(step: string, at = '12:17:45Z'): string {
  return `\n${BOLD}── ${step}  [${at}]${RESET}`;
}

/** A log for an attempt that has reached the given step, with optional extra lines. */
function logThrough(steps: number, extra = '', startedAt = '2026-09-25T12:17:45Z'): string {
  const head = [
    `${startedAt}  request: ${SHA}`,
    `${startedAt}  checkout confirms ${SHA}`,
    `${startedAt}  starting deploy`,
  ].join('\n');
  const body = STEPS.slice(0, steps)
    .map(step => stepMarker(step))
    .join('\n');
  return `${head}\n${body}\n${extra}`;
}

function files(overrides: Partial<DeployFileContents> = {}): DeployFileContents {
  return { request: null, history: null, logHead: null, logTail: null, ...overrides };
}

/** A log, supplied as both head and tail — the small-file case the reader takes. */
function logFiles(log: string, rest: Partial<DeployFileContents> = {}): DeployFileContents {
  return files({ logHead: log, logTail: log, ...rest });
}

describe('stripAnsi', () => {
  test('removes the bold and red the deploy scripts wrap their own output in', () => {
    expect(stripAnsi(`${BOLD}── 1/7  Preflight  [12:17:45Z]${RESET}`)).toBe(
      '── 1/7  Preflight  [12:17:45Z]'
    );
    expect(stripAnsi(`${RED}STOPPED: build failed${RESET}`)).toBe('STOPPED: build failed');
  });

  test('leaves the bracketed timestamp a step marker ends with alone', () => {
    expect(stripAnsi('[12:17:45Z]')).toBe('[12:17:45Z]');
  });
});

describe('parseLastAttempt', () => {
  test('reads an OK verdict', () => {
    expect(parseLastAttempt(`2026-09-25T10:17:53Z  OK ${SHA}\n`)).toEqual({
      at: '2026-09-25T10:17:53Z',
      verdict: 'OK',
      sha: SHA,
    });
  });

  test('reads a FAILED verdict with its reason, stripping the escape codes in it', () => {
    // Real line: `die()` wraps its message in red, and the reset is already
    // leaking into the history file.
    const history = [
      `2026-09-25T02:19:15Z  OK ${OTHER_SHA}`,
      `2026-09-25T06:40:35Z  FAILED ${SHA} — exit 1 — drain was armed but the box never finished` +
        ` what it was holding within 3116s — NOTHING was deployed.${RESET}; running ${OTHER_SHA}`,
    ].join('\n');
    expect(parseLastAttempt(history)).toEqual({
      at: '2026-09-25T06:40:35Z',
      verdict: 'FAILED',
      sha: SHA,
      reason:
        'exit 1 — drain was armed but the box never finished what it was holding within 3116s' +
        ` — NOTHING was deployed.; running ${OTHER_SHA}`,
    });
  });

  test('reads a KILLED verdict', () => {
    expect(
      parseLastAttempt(
        `2026-09-25T07:00:00Z  KILLED ${SHA} — stopped mid-flight; running ${OTHER_SHA}`
      )
    ).toEqual({
      at: '2026-09-25T07:00:00Z',
      verdict: 'KILLED',
      sha: SHA,
      reason: `stopped mid-flight; running ${OTHER_SHA}`,
    });
  });

  test('reads a REFUSED verdict', () => {
    expect(
      parseLastAttempt(`2026-09-25T12:17:26Z  REFUSED ${SHA} — checkout had moved to ${OTHER_SHA}`)
    ).toEqual({
      at: '2026-09-25T12:17:26Z',
      verdict: 'REFUSED',
      sha: SHA,
      reason: `checkout had moved to ${OTHER_SHA}`,
    });
  });

  test('keeps the placeholder `record()` writes when it could not read the request', () => {
    expect(parseLastAttempt('2026-09-25T12:17:26Z  REFUSED <empty> — malformed request')?.sha).toBe(
      '<empty>'
    );
  });

  test('is empty for an empty or whitespace-only history', () => {
    expect(parseLastAttempt('')).toBeUndefined();
    expect(parseLastAttempt('\n\n')).toBeUndefined();
  });

  test('reports no verdict rather than an older one when the last line will not parse', () => {
    // Answering "the last verdict" with the line before it would be a confident
    // wrong answer, which is the one thing this module must not produce.
    const history = `2026-09-25T10:17:53Z  OK ${SHA}\nsomething nothing wrote in this format\n`;
    expect(parseLastAttempt(history)).toBeUndefined();
  });

  test('reports no verdict for a word `record()` does not write', () => {
    expect(parseLastAttempt(`2026-09-25T10:17:53Z  MAYBE ${SHA}`)).toBeUndefined();
  });
});

describe('parseDeployLog', () => {
  test('takes the attempt start and SHA from the request line', () => {
    const reading = parseDeployLog(logThrough(1), logThrough(1));
    expect(reading.startedAt).toBe('2026-09-25T12:17:45Z');
    expect(reading.sha).toBe(SHA);
  });

  test('reads the last step marker for every one of the seven steps', () => {
    for (let reached = 1; reached <= DEPLOY_STEP_COUNT; reached += 1) {
      const log = logThrough(reached);
      expect(parseDeployLog(log, log).step).toEqual({
        number: reached,
        of: DEPLOY_STEP_COUNT,
        name: STEPS[reached - 1]?.replace(/^\d+\/\d+ {2}/u, '') ?? '',
      });
    }
  });

  test('reads what an armed drain is still holding', () => {
    const log = logThrough(
      5,
      [
        'drain armed for 1380s — the server is refusing new work and finishing what it has',
        'waiting up to 960s, holding 420s back for the swap',
        'draining: 1 chat mid-turn',
        'draining: 2 workflow runs executing',
      ].join('\n')
    );
    expect(parseDeployLog(log, log).holding).toBe('2 workflow runs executing');
  });

  test('reads what a timed-out drain was still holding', () => {
    const log = logThrough(5, 'still holding after 3116s: 1 chat mid-turn');
    expect(parseDeployLog(log, log).holding).toBe('1 chat mid-turn');
  });

  test('holds nothing once the wait says drained', () => {
    const log = logThrough(
      5,
      ['draining: 1 chat mid-turn', 'drained — the server is holding nothing'].join('\n')
    );
    expect(parseDeployLog(log, log).holding).toBeUndefined();
  });

  test('says nothing about holding when no drain token is configured', () => {
    const log = logThrough(5, 'no drain token configured — falling back to waiting for a turn-gap');
    expect(parseDeployLog(log, log).holding).toBeUndefined();
  });

  test('reads the step from the tail when the head is only the first kilobyte', () => {
    // The real bounded read: a build's output sits between the request line and
    // the step that matters, and this module never reads it.
    const head = `2026-09-25T12:17:45Z  request: ${SHA}\n`;
    const tail = `#55 DONE 23.4s\n${stepMarker('6/7  Restart and wait for health')}\n`;
    const reading = parseDeployLog(head, tail);
    expect(reading.startedAt).toBe('2026-09-25T12:17:45Z');
    expect(reading.step?.number).toBe(6);
  });

  test('has no step when the tail window contains no marker', () => {
    const head = `2026-09-25T12:17:45Z  request: ${SHA}\n`;
    expect(parseDeployLog(head, '#55 12.1 transforming...\n').step).toBeUndefined();
  });
});

describe('deriveDeployStatus', () => {
  test('is idle with every file missing', () => {
    // A fresh install has never deployed. That is not an error state.
    expect(deriveDeployStatus(files())).toEqual({ phase: 'idle' });
  });

  test('is idle with only a history, reporting the last verdict', () => {
    const status = deriveDeployStatus(files({ history: `2026-09-25T11:45:06Z  OK ${SHA}\n` }));
    expect(status.phase).toBe('idle');
    expect(status.last?.verdict).toBe('OK');
    expect(status.sha).toBe(SHA);
    expect(status.startedAt).toBeUndefined();
  });

  test('is requested while a deploy-request file is pending', () => {
    const status = deriveDeployStatus(
      files({ request: `${SHA}\n`, history: `2026-09-25T11:45:06Z  OK ${OTHER_SHA}\n` })
    );
    expect(status.phase).toBe('requested');
    expect(status.sha).toBe(SHA);
    expect(status.last?.sha).toBe(OTHER_SHA);
  });

  test('ignores an empty request file', () => {
    expect(deriveDeployStatus(files({ request: '\n' })).phase).toBe('idle');
  });

  test.each([
    [1, 'building'],
    [2, 'building'],
    [3, 'building'],
    [4, 'building'],
    [5, 'draining'],
    [6, 'swapping'],
    [7, 'verifying'],
  ] as const)('step %i of an in-flight attempt is %s', (reached, phase) => {
    const status = deriveDeployStatus(logFiles(logThrough(reached)));
    expect(status.phase).toBe(phase);
    expect(status.sha).toBe(SHA);
    expect(status.startedAt).toBe('2026-09-25T12:17:45Z');
    expect(status.step?.number).toBe(reached);
  });

  test('reports what the drain is holding while it is holding it', () => {
    const status = deriveDeployStatus(
      logFiles(logThrough(5, 'draining: 1 chat mid-turn, 2 workflow runs executing'))
    );
    expect(status.phase).toBe('draining');
    expect(status.holding).toBe('1 chat mid-turn, 2 workflow runs executing');
  });

  test('reports a drained box as holding nothing, still in step 5', () => {
    const status = deriveDeployStatus(
      logFiles(
        logThrough(
          5,
          ['draining: 1 chat mid-turn', 'drained — the server is holding nothing'].join('\n')
        )
      )
    );
    expect(status.phase).toBe('draining');
    expect(status.holding).toBeUndefined();
  });

  test('is unknown when an attempt is in flight and no step marker has been printed', () => {
    const log = `2026-09-25T12:17:45Z  request: ${SHA}\n2026-09-25T12:17:45Z  starting deploy\n`;
    expect(deriveDeployStatus(logFiles(log)).phase).toBe('unknown');
  });

  test('is unknown when the log step layout is not the one this reader understands', () => {
    // A restructured `deploy-local.sh` is a reader that can no longer name the
    // phase. Saying so beats deriving one from a layout that no longer holds.
    const log = `2026-09-25T12:17:45Z  request: ${SHA}${stepMarker('5/9  Something else')}\n`;
    const status = deriveDeployStatus(logFiles(log));
    expect(status.phase).toBe('unknown');
    expect(status.step).toEqual({ number: 5, of: 9, name: 'Something else' });
  });

  test('is idle once the history has recorded a verdict for the attempt in the log', () => {
    const status = deriveDeployStatus(
      logFiles(logThrough(7), { history: `2026-09-25T12:28:00Z  OK ${SHA}\n` })
    );
    expect(status.phase).toBe('idle');
    expect(status.startedAt).toBeUndefined();
    expect(status.last?.verdict).toBe('OK');
  });

  test('is still in flight when the recorded verdict predates this attempt', () => {
    // The same commit can be attempted twice, which happened three times on
    // 2026-09-25 — so matching on the SHA alone would call a running deploy
    // finished. The log's own start time is what separates them.
    const status = deriveDeployStatus(
      logFiles(logThrough(5), { history: `2026-09-25T06:40:35Z  FAILED ${SHA} — exit 1\n` })
    );
    expect(status.phase).toBe('draining');
    expect(status.startedAt).toBe('2026-09-25T12:17:45Z');
    expect(status.last?.verdict).toBe('FAILED');
  });

  test('is still in flight when the last verdict refused a different commit', () => {
    // `REFUSED — a deploy is already running` is recorded while the deploy it
    // refused to interrupt is mid-flight, and must not end that deploy's strip.
    const status = deriveDeployStatus(
      logFiles(logThrough(4), {
        history: `2026-09-25T12:20:00Z  REFUSED ${OTHER_SHA} — a deploy is already running\n`,
      })
    );
    expect(status.phase).toBe('building');
    expect(status.sha).toBe(SHA);
  });

  test('stays finished when a request for another commit is HELD afterwards (#211)', () => {
    // A held request appends a line without opening a log. Judging "finished"
    // by the last line alone would bring the finished attempt back to life.
    const status = deriveDeployStatus(
      logFiles(logThrough(7), {
        history:
          `2026-09-25T12:28:00Z  OK ${SHA}\n` +
          `2026-09-25T13:00:00Z  HELD ${OTHER_SHA} — Deploy on Merge is off (merge)\n`,
      })
    );
    expect(status.phase).toBe('idle');
    expect(status.last?.verdict).toBe('HELD');
  });

  test('reads the commit from the first line of a request that says who asked', () => {
    const status = deriveDeployStatus({
      request: `${OTHER_SHA}\nmanual 0f0e0d0c-0b0a-4908-8706-050403020100\n`,
      history: null,
      logHead: null,
      logTail: null,
    });
    expect(status.phase).toBe('requested');
    expect(status.sha).toBe(OTHER_SHA);
  });

  test('prefers the attempt in flight over a request queued behind it', () => {
    const status = deriveDeployStatus(logFiles(logThrough(4), { request: `${OTHER_SHA}\n` }));
    expect(status.phase).toBe('building');
    expect(status.sha).toBe(SHA);
  });
});

describe('readDeployFiles', () => {
  const track = trackTempRoots();
  const dir = async (): Promise<string> => track(await mkdtemp(join(tmpdir(), 'deploy-status-')));

  test('reads all three files when they are there', async () => {
    const root = await dir();
    await writeFile(join(root, 'deploy-request'), `${SHA}\n`);
    await writeFile(join(root, 'deploy-history'), `2026-09-25T11:45:06Z  OK ${OTHER_SHA}\n`);
    await writeFile(join(root, 'deploy-last.log'), logThrough(4));

    const contents = await readDeployFiles(root);
    expect(contents.request?.trim()).toBe(SHA);
    expect(contents.history).toContain('OK');
    expect(contents.logHead).toContain('request:');
    expect(deriveDeployStatus(contents).phase).toBe('building');
  });

  test('reports every file as absent for a directory that has none of them', async () => {
    const contents = await readDeployFiles(await dir());
    expect(contents).toEqual({ request: null, history: null, logHead: null, logTail: null });
    expect(deriveDeployStatus(contents)).toEqual({ phase: 'idle' });
  });

  test('reports absent files for a directory that does not exist at all', async () => {
    const contents = await readDeployFiles(join(await dir(), 'never-created'));
    expect(deriveDeployStatus(contents)).toEqual({ phase: 'idle' });
  });

  test('finds the request line and the last step in a log too big to read whole', async () => {
    const root = await dir();
    const filler = `${'#55 DONE 0.1s '.repeat(64)}\n`.repeat(9000); // ~8 MiB of build output
    await writeFile(
      join(root, 'deploy-last.log'),
      `${logThrough(4)}\n${filler}${stepMarker('6/7  Restart and wait for health')}\n`
    );
    const status = deriveDeployStatus(await readDeployFiles(root));
    expect(status.phase).toBe('swapping');
    expect(status.startedAt).toBe('2026-09-25T12:17:45Z');
  });
});
