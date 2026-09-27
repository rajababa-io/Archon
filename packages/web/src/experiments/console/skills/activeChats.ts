/**
 * What the server is doing, right now — and what is about to replace it.
 *
 * `/api/health` reports the conversation halves — `concurrency.activeConversationIds`
 * says WHICH chats are moving, `concurrency.activeTools` says what each is doing —
 * and the ids are platform ids (`web-<ts>-<rand>`), the same ones the rail keys
 * its rows by. Neither is in the generated OpenAPI schema, so the shape is
 * declared here rather than derived, and read defensively: a missing or
 * malformed field yields nothing, never an exception.
 *
 * `deploy` rides the SAME read, and that is the point rather than a convenience.
 * A deploy drains the box before it swaps the container: it stops admitting new
 * work and waits for the turns already in flight to finish. So asking a chat how
 * a deploy is going is itself one of the things the deploy is waiting for — on
 * 2026-09-25 a chat that woke every twenty minutes to check held the drain for
 * 3116 seconds and the deploy failed. A second always-on timer would not take a
 * conversation turn either, but this one already exists and already asks the
 * endpoint that carries the answer.
 */
import { requestJson } from '../lib/http';
import type { HealthResponse } from './settings';

/**
 * The deploy block of `/api/health`, taken from the generated OpenAPI types
 * rather than restated here. The server derives it from the host's deploy files
 * (see `services/deploy-status`); this is the one declaration, and the schema
 * that produced it is the owner.
 */
export type DeployStatus = NonNullable<HealthResponse['deploy']>;

const DEPLOY_PHASES: readonly DeployStatus['phase'][] = [
  'requested',
  'building',
  'draining',
  'swapping',
  'verifying',
  'idle',
  'unknown',
];

const DEPLOY_VERDICTS: readonly NonNullable<DeployStatus['last']>['verdict'][] = [
  'OK',
  'FAILED',
  'REFUSED',
  'KILLED',
];

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseStep(raw: unknown): DeployStatus['step'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { number, of, name } = raw as { number?: unknown; of?: unknown; name?: unknown };
  if (typeof number !== 'number' || typeof of !== 'number' || typeof name !== 'string') {
    return undefined;
  }
  return { number, of, name };
}

function parseLast(raw: unknown): DeployStatus['last'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { at, verdict, sha, reason } = raw as {
    at?: unknown;
    verdict?: unknown;
    sha?: unknown;
    reason?: unknown;
  };
  if (typeof at !== 'string' || typeof sha !== 'string') return undefined;
  if (typeof verdict !== 'string') return undefined;
  if (!DEPLOY_VERDICTS.includes(verdict as NonNullable<DeployStatus['last']>['verdict'])) {
    return undefined;
  }
  return {
    at,
    verdict: verdict as NonNullable<DeployStatus['last']>['verdict'],
    sha,
    ...(optionalString(reason) !== undefined ? { reason: optionalString(reason) } : {}),
  };
}

/**
 * Read the deploy block, or nothing.
 *
 * A phase this build does not know is dropped rather than rendered: the strip's
 * whole value is that it never states a phase it cannot prove, and a word from a
 * newer server is one this client cannot describe. The generated type is a
 * compile-time claim about the schema, not a guarantee about the bytes that
 * arrive, which is why this checks.
 */
export function parseDeploy(raw: unknown): DeployStatus | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { phase, sha, startedAt, step, holding, last } = raw as Record<string, unknown>;
  if (typeof phase !== 'string') return undefined;
  if (!DEPLOY_PHASES.includes(phase as DeployStatus['phase'])) return undefined;
  const parsedStep = parseStep(step);
  const parsedLast = parseLast(last);
  return {
    phase: phase as DeployStatus['phase'],
    ...(optionalString(sha) !== undefined ? { sha: optionalString(sha) } : {}),
    ...(optionalString(startedAt) !== undefined ? { startedAt: optionalString(startedAt) } : {}),
    ...(parsedStep ? { step: parsedStep } : {}),
    ...(optionalString(holding) !== undefined ? { holding: optionalString(holding) } : {}),
    ...(parsedLast ? { last: parsedLast } : {}),
  };
}

interface HealthLive {
  concurrency?: { activeConversationIds?: unknown; activeTools?: unknown };
  ciWaitingConversationIds?: unknown;
  deploy?: unknown;
}

/** The tool a chat is running, as the strip and the rail need it described. */
export interface ActiveTool {
  name: string;
  input: Record<string, string>;
}

export interface ActiveChats {
  ids: readonly string[];
  /** Keyed by platform conversation id. Absent for a chat between tools. */
  tools: Readonly<Record<string, ActiveTool>>;
  /**
   * Platform ids of chats with an open CI watch — waiting on something the
   * server is watching for them, rather than on nothing.
   */
  ciWaiting: readonly string[];
  /**
   * What a deploy replacing this server is doing, when the server could tell.
   * Absent on a build whose health route predates the deploy block, and absent
   * when the server could not read the host's deploy files — in both cases the
   * strip says nothing rather than guessing.
   */
  deploy?: DeployStatus;
}

function parseTools(raw: unknown): Record<string, ActiveTool> {
  const out: Record<string, ActiveTool> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const { name, input } = value as { name?: unknown; input?: unknown };
    if (typeof name !== 'string' || name === '') continue;
    // The server bounds the input to short strings; anything else is dropped
    // rather than rendered, because this only ever becomes one short line.
    const fields: Record<string, string> = {};
    if (typeof input === 'object' && input !== null) {
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (typeof v === 'string') fields[k] = v;
      }
    }
    out[id] = { name, input: fields };
  }
  return out;
}

function parseIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

export async function getActiveChats(): Promise<ActiveChats> {
  const res = await requestJson<HealthLive>('/api/health');
  const deploy = parseDeploy(res.deploy);
  return {
    ids: parseIds(res.concurrency?.activeConversationIds),
    tools: parseTools(res.concurrency?.activeTools),
    ciWaiting: parseIds(res.ciWaitingConversationIds),
    ...(deploy ? { deploy } : {}),
  };
}
