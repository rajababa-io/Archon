/**
 * What the deploy replacing this server is doing, read from the host's own files.
 *
 * WHY THIS EXISTS. A deploy on this install takes five to twenty minutes and is
 * invisible while it runs. The only surfaces are two files in the Archon home —
 * `deploy-history`, one line per attempt, and `deploy-last.log`, the current
 * attempt's output — and nothing in the console read either. So the only way to
 * find out how a deploy was going was to ask the agent, and asking is itself one
 * of the things the deploy is waiting for: drain finishes the turns already in
 * flight before it swaps the container, and a question is a turn. On 2026-09-25 a
 * chat woke every twenty minutes to check, held the drain for 3116 seconds, and
 * the deploy failed; left alone, the same commit went live in eleven minutes.
 * Watching a deploy must not take a conversation turn, which is why this rides
 * `/api/health` and answers from files rather than from anything that needs the
 * conversation lock.
 *
 * DERIVED AT READ TIME, NEVER PERSISTED. The server being replaced is the one
 * answering the request. A phase written to the database would be stale across
 * exactly the swap it exists to describe.
 *
 * WHAT IT IS ALLOWED TO CLAIM. These files are written by shell scripts for
 * humans, so most of their content is prose and none of it is a wire format.
 * Three things here are not prose, and are what the phase rests on:
 *
 *   1. whether `deploy-request` exists — a pending request, nothing else;
 *   2. the last line of `deploy-history`, written by one `record()` in
 *      `scripts/deploy-on-request.sh` as `<ISO8601>  <VERDICT> <sha>[ — reason]`;
 *   3. the numbered step markers in the log, written by one `step()` in
 *      `scripts/deploy-local.sh` as `── <n>/7  <name>  [HH:MM:SSZ]`.
 *
 * Everything unmatched is `unknown`. A strip that says healthy during a failed
 * deploy is worse than no strip, so nothing here guesses: an unrecognised step
 * layout, an unparseable history line, and a log this reader cannot follow all
 * come back as an absence or as `unknown`, never as a phase.
 *
 * The producers — `scripts/deploy-on-request.sh`, `scripts/deploy-local.sh` and
 * `scripts/drain-wait.ts` — are read-only from here. Changing one of them to
 * suit this reader would need a deploy before the reader could rely on it.
 */

import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { getArchonHome } from '@archon/paths/archon-paths';

/**
 * The verdicts `record()` can write. Anything else is a history line this reader
 * does not understand, and is reported as no verdict rather than as a new one.
 *
 * `HELD` is a request the host set aside without starting it: a merge-sourced
 * request while the project's Deploy on Merge is off (#211). It opens no log.
 */
export const DEPLOY_VERDICTS = ['OK', 'FAILED', 'REFUSED', 'KILLED', 'HELD'] as const;
export type DeployVerdict = (typeof DEPLOY_VERDICTS)[number];

/** One line of `deploy-history`. */
export interface DeployAttempt {
  /** When the verdict was recorded, ISO 8601 with a `Z`. */
  at: string;
  verdict: DeployVerdict;
  /**
   * The commit the attempt was for. Usually a 40-character SHA, but `record()`
   * also writes `<empty>` and `?` for a request it refused to read, so this is
   * whatever was in the file and the caller decides whether it can be shortened.
   */
  sha: string;
  /** Everything after the em dash, when there was one. */
  reason?: string;
}

/**
 * Where a deploy has got to.
 *
 * The four in-flight phases are the step ranges of `scripts/deploy-local.sh`:
 * steps 1-4 prepare and build and disturb nothing, step 5 waits for the box to
 * hold nothing, step 6 swaps the container, step 7 asks the new one which commit
 * it is.
 */
export type DeployPhase =
  /** A `deploy-request` file exists and the host has not started on it. */
  | 'requested'
  /** Steps 1-4: preflight, remote, pull, build. */
  | 'building'
  /** Step 5: waiting for the box to finish what it holds. */
  | 'draining'
  /** Step 6: the container is being recreated. */
  | 'swapping'
  /** Step 7: asking the new container which commit it is running. */
  | 'verifying'
  /** No attempt in flight and no request pending. */
  | 'idle'
  /** An attempt is in flight and this reader cannot say where it has got to. */
  | 'unknown';

/** The step marker the log last printed. */
export interface DeployStep {
  number: number;
  of: number;
  /** The step's own name, as `deploy-local.sh` spells it. */
  name: string;
}

export interface DeployStatus {
  phase: DeployPhase;
  /**
   * The commit this is about: the attempt in flight, the pending request, or the
   * last recorded attempt — in that order. Full length; shortening is the
   * caller's business.
   */
  sha?: string;
  /** When the attempt in flight started, ISO 8601. Absent when nothing is in flight. */
  startedAt?: string;
  step?: DeployStep;
  /**
   * What a drain is still holding, in the words `drain-wait.ts` uses — `1 chat
   * mid-turn`, `2 workflow runs executing`. Absent when it holds nothing, and
   * when the wait has not said yet.
   */
  holding?: string;
  /** The last verdict in `deploy-history`. */
  last?: DeployAttempt;
}

/**
 * Strip the escape codes the scripts wrap their own output in.
 *
 * `step()` emits bold and `die()` emits red, and the red one is already leaking
 * into `deploy-history` — the trailing reset at the end of every FAILED reason.
 * Stripping happens before any matching, so a bolded step marker matches the
 * same pattern as a bare one.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- the escape codes are the thing being stripped
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/gu, '');
}

const HISTORY_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) {2}([A-Z]+) (\S+)(?: — (.*))?$/u;

function isVerdict(word: string): word is DeployVerdict {
  return (DEPLOY_VERDICTS as readonly string[]).includes(word);
}

/**
 * The last verdict in `deploy-history`.
 *
 * Only the LAST non-empty line is considered. Falling back to the line before it
 * when that one will not parse would answer "the last verdict" with an older
 * one, which is the confident wrong answer this whole module exists to avoid.
 */
export function parseLastAttempt(history: string): DeployAttempt | undefined {
  const lines = historyLines(history);
  const last = lines.at(-1);
  return last === undefined ? undefined : parseHistoryLine(last);
}

function historyLines(history: string): string[] {
  return stripAnsi(history)
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line !== '');
}

function parseHistoryLine(line: string): DeployAttempt | undefined {
  const match = HISTORY_LINE.exec(line);
  if (!match) return undefined;
  const [, at, verdict, sha, reason] = match;
  if (at === undefined || verdict === undefined || sha === undefined) return undefined;
  if (!isVerdict(verdict)) return undefined;
  return { at, verdict, sha, ...(reason !== undefined && reason !== '' ? { reason } : {}) };
}

/**
 * Every line of `deploy-history` this reader understands, oldest first. Lines it
 * cannot parse are skipped here — unlike {@link parseLastAttempt}, a caller of
 * this is looking FOR a particular attempt, and an unreadable line is simply not
 * that attempt.
 */
export function parseAttempts(history: string): DeployAttempt[] {
  return historyLines(history)
    .map(parseHistoryLine)
    .filter((attempt): attempt is DeployAttempt => attempt !== undefined);
}

/**
 * `<ISO8601>  request: <sha>`, the first thing `deploy-on-request.sh` writes to a
 * fresh log. It is the only line carrying the attempt's DATE — the step markers
 * carry a time of day and nothing else — so it is what elapsed time is measured
 * from, and what tells this reader which attempt the log belongs to.
 */
const REQUEST_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) {2}request: (.*)$/u;

/** `── <n>/<of>  <name>  [HH:MM:SSZ]`, from `step()` in `deploy-local.sh`. */
const STEP_MARKER = /^── (\d+)\/(\d+) {2}(.*) {2}\[\d{2}:\d{2}:\d{2}Z\]$/u;

/**
 * `draining: <holding>` and `still holding after <n>s: <holding>` from
 * `waitForDrain` in `scripts/drain-wait.ts`, and the line that says it is over.
 * The waiter logs the holding sentence only when it CHANGES, so the last one of
 * these in the log is the current answer.
 */
const DRAINING_LINE = /^draining: (.+)$/u;
const STILL_HOLDING_LINE = /^still holding after \d+s: (.+)$/u;
const HOLDS_NOTHING_PREFIX = 'drained — ';

/** The number of steps `deploy-local.sh` has. */
export const DEPLOY_STEP_COUNT = 7;

/**
 * The phase a step number means.
 *
 * Keyed on the number rather than the name, because the numbers are the
 * generated half of the marker and the names are prose. A log whose steps do not
 * go up to `DEPLOY_STEP_COUNT` is a `deploy-local.sh` that has been restructured
 * since this was written, and the honest answer then is `unknown` rather than a
 * phase derived from a layout that no longer holds. `deploy-local.test.ts`
 * asserts the script still has exactly these steps, so this cannot drift
 * unnoticed.
 */
function phaseForStep(step: DeployStep): DeployPhase {
  if (step.of !== DEPLOY_STEP_COUNT) return 'unknown';
  if (step.number >= 1 && step.number <= 4) return 'building';
  if (step.number === 5) return 'draining';
  if (step.number === 6) return 'swapping';
  if (step.number === 7) return 'verifying';
  return 'unknown';
}

/** What one `deploy-last.log` says, before it is reconciled with the history. */
export interface DeployLogReading {
  startedAt?: string;
  sha?: string;
  step?: DeployStep;
  holding?: string;
}

/**
 * Read the log.
 *
 * `head` and `tail` may be the same text — for a log small enough to be read
 * whole they are — because the request line is near the start and the markers
 * that matter are near the end, and a docker build's output between them can be
 * hundreds of kilobytes that this never needs.
 */
export function parseDeployLog(head: string, tail: string): DeployLogReading {
  const reading: DeployLogReading = {};

  for (const line of stripAnsi(head).split('\n')) {
    const match = REQUEST_LINE.exec(line.trimEnd());
    if (match) {
      const [, at, sha] = match;
      if (at !== undefined && sha !== undefined && sha !== '') {
        reading.startedAt = at;
        reading.sha = sha;
      }
      break;
    }
  }

  // Last one wins for both: the step the deploy has reached, and the drain's
  // most recent answer about what it is holding.
  for (const raw of stripAnsi(tail).split('\n')) {
    const line = raw.trimEnd();

    const step = STEP_MARKER.exec(line);
    if (step) {
      const [, number, of, name] = step;
      if (number !== undefined && of !== undefined && name !== undefined) {
        reading.step = { number: Number(number), of: Number(of), name };
      }
      continue;
    }

    const draining = DRAINING_LINE.exec(line) ?? STILL_HOLDING_LINE.exec(line);
    if (draining?.[1] !== undefined) {
      reading.holding = draining[1];
      continue;
    }
    if (line.startsWith(HOLDS_NOTHING_PREFIX)) delete reading.holding;
  }

  return reading;
}

/** The three files, as text. `null` means the file is not there. */
export interface DeployFileContents {
  /** The pending request, if one exists. Its content is the requested SHA. */
  request: string | null;
  history: string | null;
  /** The start of `deploy-last.log`, and its end. Both null when there is no log. */
  logHead: string | null;
  logTail: string | null;
}

/**
 * Reconcile the three files into one answer.
 *
 * WHETHER AN ATTEMPT IS STILL RUNNING is decided structurally, not by looking for
 * words like "DEPLOYED" in the log. `record()` appends exactly one history line
 * per attempt, at the end of it, so a log whose attempt has a matching history
 * line recorded at or after the log started is an attempt that is over. That
 * survives the case the log cannot distinguish on its own: the same commit
 * deployed twice, which happened three times on 2026-09-25.
 */
export function deriveDeployStatus(files: DeployFileContents): DeployStatus {
  const last = files.history === null ? undefined : parseLastAttempt(files.history);
  const log =
    files.logHead === null || files.logTail === null
      ? undefined
      : parseDeployLog(files.logHead, files.logTail);

  // Any verdict for this log's commit recorded after it started, not only the
  // last line: a request HELD or REFUSED after an attempt finished appends a line
  // about a different commit, and must not make the finished attempt look live
  // again. HELD itself never ends an attempt — it is written without one.
  const startedAt = log?.startedAt;
  const finished =
    startedAt !== undefined &&
    files.history !== null &&
    parseAttempts(files.history).some(
      attempt => attempt.verdict !== 'HELD' && attempt.sha === log?.sha && attempt.at >= startedAt
    );
  const inFlight = log?.startedAt !== undefined && !finished;

  // An attempt already running outranks a pending request, because it is the
  // more informative of the two and the request is about to be refused: the
  // deploy takes an exclusive lock, and a second request while it holds one is
  // recorded as REFUSED. A request with nothing in flight is the common case —
  // the seconds between the container writing the file and the host's path unit
  // acting on it.
  if (inFlight && log !== undefined) {
    return {
      phase: log.step === undefined ? 'unknown' : phaseForStep(log.step),
      ...(log.sha !== undefined ? { sha: log.sha } : {}),
      startedAt: log.startedAt,
      ...(log.step !== undefined ? { step: log.step } : {}),
      ...(log.holding !== undefined ? { holding: log.holding } : {}),
      ...(last !== undefined ? { last } : {}),
    };
  }

  // The request's first line is the commit; a second line, when present, is who
  // asked (`merge` or `manual <id>`) and is the host's business, not this one's.
  const pending = files.request?.trim().split('\n')[0]?.trim();
  if (pending !== undefined && pending !== '') {
    return {
      phase: 'requested',
      sha: pending,
      ...(last !== undefined ? { last } : {}),
    };
  }

  return {
    phase: 'idle',
    ...(last !== undefined ? { sha: last.sha, last } : {}),
  };
}

/**
 * How much of the log to read.
 *
 * The request line is in the first few hundred bytes and the markers that matter
 * are at the end; between them sits a docker build's entire output. Reading the
 * whole file on every health poll — and `/api/health` is also the container's
 * healthcheck — would be megabytes of nothing.
 */
const LOG_HEAD_BYTES = 1024;
const LOG_TAIL_BYTES = 512 * 1024;

/**
 * Read a file, or `null` when it is not there.
 *
 * A missing file is not an error. A fresh install has never deployed and has none
 * of these; that is the `idle` answer, not a failure. Any OTHER failure is
 * thrown, for the caller to report as an absent deploy block rather than as a
 * confident one.
 */
async function readWhole(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** The first and last slice of a file, without reading what is in between. */
async function readEnds(path: string): Promise<{ head: string; tail: string } | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const read = async (start: number, length: number): Promise<string> => {
      if (length <= 0) return '';
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead).toString('utf8');
    };
    if (size <= LOG_TAIL_BYTES) {
      const whole = await read(0, size);
      return { head: whole, tail: whole };
    }
    return {
      head: await read(0, LOG_HEAD_BYTES),
      tail: await read(size - LOG_TAIL_BYTES, LOG_TAIL_BYTES),
    };
  } finally {
    await handle.close();
  }
}

export async function readDeployFiles(dir: string = getArchonHome()): Promise<DeployFileContents> {
  const [request, history, log] = await Promise.all([
    readWhole(join(dir, 'deploy-request')),
    readWhole(join(dir, 'deploy-history')),
    readEnds(join(dir, 'deploy-last.log')),
  ]);
  return {
    request,
    history,
    logHead: log?.head ?? null,
    logTail: log?.tail ?? null,
  };
}

/** The whole answer, for `/api/health`. */
export async function getDeployStatus(dir?: string): Promise<DeployStatus> {
  return deriveDeployStatus(await readDeployFiles(dir));
}
