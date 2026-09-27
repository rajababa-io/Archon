/**
 * Wait for the server to finish what it is holding, after a deploy has armed
 * drain, so the container can be recreated without destroying work.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `turn-gap.ts`. Both scripts answer "may the
 * container be recreated now", but they get there differently, and the
 * difference is the whole point. `turn-gap.ts` WAITS FOR a quiet moment: it
 * polls and succeeds only if the box happens to be idle at the instant it
 * looks. On a box running several conversations at once that instant may never
 * arrive — deploys on this install starved for two days in September 2026, and
 * the only escape hatch was `SKIP_TURN_GAP=1`, which ends live turns and loses
 * the work in them.
 *
 * Drain MAKES the quiet moment instead. `POST /internal/drain` stops the server
 * admitting new work; what it already holds runs to completion; `/api/health`
 * grows a `drain` block that says `drained` once it holds nothing. So this waits
 * on a count that only ever falls, rather than on a coincidence.
 *
 * TWO CONSEQUENCES OF THAT, both load-bearing:
 *
 * 1. No confirming second reading. `turn-gap.ts` reads twice, because its first
 *    reading can land in the instant between one turn ending and the next
 *    beginning. Under drain there is no next turn to land in front of — nothing
 *    new is admitted — so one reading of `drained` is the truth.
 * 2. The drain block being ABSENT is a distinct failure, not a quiet box. Absent
 *    means the drain this deploy armed is no longer in effect: its budget
 *    lapsed, or something else cancelled it. Swapping then would destroy work
 *    the server had already started accepting again, so it exits its own code
 *    and the deploy says so in its own words.
 *
 * WHAT IT DOES NOT DO. It neither arms nor cancels drain. Arming is a capability
 * and cancelling it again on every failing path is the single biggest risk in
 * the mechanism, so both belong to one owner: the host half, in
 * `deploy-local.sh`, where a shell `trap` can guarantee the cancel. This is only
 * the reader.
 */

import { MAX_DRAIN_BUDGET_SECONDS } from '../packages/server/src/routes/drain-budget';
import { PARK_BLOCK_REASONS } from '../packages/server/src/routes/drain-park-reasons';

/**
 * Exit codes. The deploy gives each one different words, because they are
 * different operator problems: a box that will not finish, a drain that went
 * away underneath the deploy, and an endpoint that cannot be read at all.
 */
export const DRAIN_HELD_NOTHING = 0;
export const DRAIN_TIMED_OUT = 1;
export const DRAIN_UNREADABLE = 2;
export const DRAIN_NOT_IN_EFFECT = 3;

export interface DrainWaitSettings {
  /** Where to ask. The server about to be replaced, not the new one. */
  healthUrl: string;
  /** Give up after this many seconds and deploy nothing. */
  timeoutSeconds: number;
  /** Seconds between polls while it is still holding something. */
  intervalSeconds: number;
}

export const DRAIN_WAIT_DEFAULTS: DrainWaitSettings = {
  healthUrl: 'http://localhost:3000/api/health',
  timeoutSeconds: 1800,
  intervalSeconds: 5,
};

/**
 * The server refuses a budget above its own maximum, so the deploy clamps rather
 * than discovering the refusal after it has already armed the trap that cancels.
 * The limit is IMPORTED from the route that enforces it: a copy of the number
 * here would be a second declaration kept in agreement by nobody.
 */
export function clampDrainBudget(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`drain budget must be a positive number of seconds, got ${String(seconds)}`);
  }
  return Math.min(Math.floor(seconds), MAX_DRAIN_BUDGET_SECONDS);
}

/** What one reading of `/api/health` says about the drain this deploy armed. */
export type DrainReading =
  | { state: 'drained' }
  /** Still holding something. `holding` is the sentence a watching operator reads. */
  | { state: 'draining'; holding: string }
  /** No drain block at all — the drain is not in effect any more. */
  | { state: 'absent' };

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`health payload has no usable ${field}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Read a count that must be there.
 *
 * A missing field is an error rather than a zero, for the same reason as in
 * `turn-gap.ts`: treating "I could not find the count" as "the count is zero"
 * reports a swappable box at exactly the moment the reading stopped being
 * trustworthy, which is the one direction this must never fail in.
 */
function requireCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`health payload has no usable ${field} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * What the drain is still holding, or null when it holds nothing.
 *
 * The phrasing mirrors `turn-gap.ts` on purpose — an operator reading a deploy
 * log should not have to learn two vocabularies for the same three counts — but
 * the fields are the server's own `drain.holding`, not the health route's
 * top-level concurrency, so nothing is shared between the two scripts.
 */
function holdingSentence(holding: Record<string, unknown>): string | null {
  const chats = requireCount(holding.activeConversations, 'drain.holding.activeConversations');
  const queued = requireCount(holding.queuedMessages, 'drain.holding.queuedMessages');
  const workflows = requireCount(holding.runningWorkflows, 'drain.holding.runningWorkflows');

  const reasons: string[] = [];
  if (chats > 0) reasons.push(`${plural(chats, 'chat', 'chats')} mid-turn`);
  if (queued > 0) reasons.push(`${plural(queued, 'message', 'messages')} queued`);
  if (workflows > 0)
    reasons.push(`${plural(workflows, 'workflow run', 'workflow runs')} executing`);

  return reasons.length === 0 ? null : reasons.join(', ');
}

/**
 * Read one `/api/health` payload.
 *
 * Throws when the payload cannot be read; the caller must treat that as "do not
 * deploy" rather than as "drained".
 *
 * `state` and `holding` are checked AGAINST EACH OTHER rather than one being
 * trusted. The server derives the word from the counts, so on a matched pair
 * they cannot disagree — but the deploy script and the server it is replacing
 * are shipped separately and can skew by a version, and this is the one place
 * where believing the wrong half costs somebody's work.
 */
export function readDrain(payload: unknown): DrainReading {
  const health = asRecord(payload, 'body');
  if (health.drain === undefined) return { state: 'absent' };

  const drain = asRecord(health.drain, 'drain');
  const holding = holdingSentence(asRecord(drain.holding, 'drain.holding'));

  if (drain.state === 'drained') {
    if (holding !== null) {
      throw new Error(`drain says drained while still holding ${holding}`);
    }
    return { state: 'drained' };
  }
  if (drain.state === 'draining') {
    if (holding === null) {
      throw new Error('drain says draining while holding nothing');
    }
    return { state: 'draining', holding };
  }
  throw new Error(`drain.state is not a state this deploy knows: ${JSON.stringify(drain.state)}`);
}

/** Read settings from the environment, so the deploy script can tune them without arguments. */
export function settingsFromEnv(env: Record<string, string | undefined>): DrainWaitSettings {
  const seconds = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(
        `${key} must be a non-negative number of seconds, got ${JSON.stringify(raw)}`
      );
    }
    return parsed;
  };
  const url = env.HEALTH_URL;
  return {
    healthUrl: url !== undefined && url.trim() !== '' ? url : DRAIN_WAIT_DEFAULTS.healthUrl,
    timeoutSeconds: seconds('DRAIN_WAIT_TIMEOUT', DRAIN_WAIT_DEFAULTS.timeoutSeconds),
    intervalSeconds: seconds('DRAIN_WAIT_INTERVAL', DRAIN_WAIT_DEFAULTS.intervalSeconds),
  };
}

const sleep = (seconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, seconds * 1000));

async function read(healthUrl: string): Promise<DrainReading> {
  const response = await fetch(healthUrl);
  if (!response.ok) throw new Error(`health returned ${String(response.status)}`);
  return readDrain(await response.json());
}

export async function waitForDrain(
  settings: DrainWaitSettings,
  log: (line: string) => void
): Promise<number> {
  const deadline = Date.now() + settings.timeoutSeconds * 1000;
  let lastReported = '';

  for (;;) {
    let reading: DrainReading;
    try {
      reading = await read(settings.healthUrl);
    } catch (error: unknown) {
      // Unreadable is not drained. Stopping here leaves the box running what it
      // was running, which is the safe end of this decision.
      log(`cannot tell what the drain is holding: ${(error as Error).message}`);
      return DRAIN_UNREADABLE;
    }

    if (reading.state === 'drained') {
      log('drained — the server is holding nothing');
      return DRAIN_HELD_NOTHING;
    }
    if (reading.state === 'absent') {
      log('the drain is no longer in effect — its budget lapsed, or it was cancelled');
      return DRAIN_NOT_IN_EFFECT;
    }

    if (Date.now() >= deadline) {
      log(`still holding after ${String(settings.timeoutSeconds)}s: ${reading.holding}`);
      return DRAIN_TIMED_OUT;
    }

    // Only on change, plus whatever the interval gives. Half an hour of the same
    // line every five seconds buries the one that matters.
    if (reading.holding !== lastReported) {
      log(`draining: ${reading.holding}`);
      lastReported = reading.holding;
    }
    await sleep(settings.intervalSeconds);
  }
}

interface ParkCounts {
  chats: number;
  queuedMessages: number;
  runs: number;
}

function readCounts(value: unknown, field: string): ParkCounts {
  const counts = asRecord(value, field);
  return {
    chats: requireCount(counts.chats, `${field}.chats`),
    queuedMessages: requireCount(counts.queuedMessages, `${field}.queuedMessages`),
    runs: requireCount(counts.runs, `${field}.runs`),
  };
}

function describeCounts(counts: ParkCounts): string {
  return [
    plural(counts.chats, 'chat', 'chats'),
    plural(counts.queuedMessages, 'queued message', 'queued messages'),
    plural(counts.runs, 'workflow run', 'workflow runs'),
  ].join(', ');
}

/**
 * The lines the deploy prints for a `POST /internal/drain/park` answer. The first
 * is the drain id alone, which the deploy keeps to ask the new server for its
 * report; it is checked to be a UUID because it is interpolated into a URL.
 */
export function parkAnswerLines(payload: unknown): string[] {
  const answer = asRecord(payload, 'body');
  const drainId = answer.drainId;
  if (
    typeof drainId !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(drainId)
  ) {
    throw new Error(`park answer has no usable drainId (got ${JSON.stringify(drainId)})`);
  }
  const parked = readCounts(answer.parked, 'parked');
  if (!Array.isArray(answer.blocked)) throw new Error('park answer has no usable blocked list');
  const blocked = answer.blocked.map((raw: unknown, index) => {
    const item = asRecord(raw, `blocked[${String(index)}]`);
    const { kind, id, reason } = item;
    if (typeof kind !== 'string' || typeof id !== 'string' || typeof reason !== 'string') {
      throw new Error(`park answer has an unreadable blocked[${String(index)}]`);
    }
    // A reason from a newer server than this script is shown as it came.
    const why = Object.hasOwn(PARK_BLOCK_REASONS, reason)
      ? PARK_BLOCK_REASONS[reason as keyof typeof PARK_BLOCK_REASONS]
      : reason;
    return `still running, waiting for it: ${kind} ${id} — ${why}`;
  });
  return [drainId, `parked ${describeCounts(parked)}`, ...blocked];
}

/** The deploy history's summary of a `GET /internal/drain/park/<id>` answer. */
export function resumeReport(payload: unknown): { line: string; complete: boolean } {
  const summary = asRecord(payload, 'body');
  const parked = readCounts(summary.parked, 'parked');
  const resumed = readCounts(summary.resumed, 'resumed');
  const complete = (Object.keys(parked) as (keyof ParkCounts)[]).every(
    key => resumed[key] >= parked[key]
  );
  return { line: `parked ${describeCounts(parked)}; resumed ${describeCounts(resumed)}`, complete };
}

/**
 * The invocations, because the host half needs answers from the one place that
 * owns them and has no JSON reader of its own:
 *
 *   --budget <seconds>   print the budget to arm drain with, clamped
 *   --park-answer        read a park answer on stdin; print the drain id, then
 *                        the lines for the deploy log
 *   --resume-report      read a park summary on stdin; print its report line, and
 *                        exit 0 once everything parked has resumed, 1 before
 *   (no arguments)       poll until drained, and exit with one of the codes above
 */
if (import.meta.main) {
  const [flag, value] = process.argv.slice(2);
  if (flag === '--budget') {
    console.log(String(clampDrainBudget(Number(value))));
  } else if (flag === '--park-answer') {
    for (const line of parkAnswerLines(JSON.parse(await Bun.stdin.text()))) console.log(line);
  } else if (flag === '--resume-report') {
    let report: ReturnType<typeof resumeReport>;
    try {
      report = resumeReport(JSON.parse(await Bun.stdin.text()));
    } catch (error: unknown) {
      console.error(`cannot read the park summary: ${(error as Error).message}`);
      process.exit(2);
    }
    console.log(report.line);
    process.exit(report.complete ? 0 : 1);
  } else if (flag !== undefined) {
    console.error(`unknown argument ${JSON.stringify(flag)}`);
    process.exit(64);
  } else {
    process.exit(
      await waitForDrain(settingsFromEnv(process.env), line => {
        console.log(line);
      })
    );
  }
}
