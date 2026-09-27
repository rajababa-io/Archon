/**
 * Drain control — the host-only switch a deploy uses to manufacture a quiet moment.
 *
 * The app is baked into its image, so shipping a commit recreates the container.
 * Without drain a deploy can only poll `/api/health` and hope every conversation
 * goes idle at once; on a box with several concurrent sessions that moment never
 * arrives. Drain makes it: the server stops admitting new work, finishes what it
 * already holds, and `/api/health` reports `drain.state: 'drained'` once it holds
 * nothing. The deploy swaps then — or, if the budget lapses first, deploys nothing.
 *
 * When waiting would outlast the budget, the deploy parks what is still running
 * (`POST /internal/drain/park`, see ../services/deploy-park) and waits only for what
 * could not be parked. Cancelling drain hands parked work straight back.
 *
 * Registered outside the OpenAPI surface and only when `ARCHON_DRAIN_TOKEN` is set,
 * so an install that has not configured a token has no drain endpoint at all.
 *
 * SECURITY: stopping a production server from accepting work is a capability, so
 * these routes carry their own bearer token rather than relying on `/internal/*`
 * not being proxied. The `/internal/git-credential` bind guard does not cover them:
 * it is fatal and fires only in GitHub App mode, and extending it would refuse to
 * start for every operator on the default Docker bind.
 */

import { timingSafeEqual } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import { summarizeDrain } from '@archon/core/db/parked-work';
import { createLogger } from '@archon/paths';
import { MAX_DRAIN_BUDGET_SECONDS } from './drain-budget';
import { NotDrainingError, parkForDeploy, type ParkLockManager } from '../services/deploy-park';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server');
  return cachedLog;
}

// Re-exported so this route stays the one name importers reach for, while the
// value itself sits in a module a deploy script can import without pulling the
// server's dependency graph in with it. See drain-budget.ts.
export { MAX_DRAIN_BUDGET_SECONDS };

const drainRequestSchema = z.object({
  budgetSeconds: z.number().positive().max(MAX_DRAIN_BUDGET_SECONDS),
  // How long the deploy lets the box finish before it parks what is left. Only
  // reported back through health; an older deploy script omits it.
  graceSeconds: z.number().nonnegative().max(MAX_DRAIN_BUDGET_SECONDS).optional(),
});

/** The slice of the lock manager these routes drive. */
export type DrainTarget = Pick<ConversationLockManager, 'beginDrain' | 'cancelDrain'> &
  ParkLockManager;

const drainIdSchema = z.string().uuid();

/**
 * Constant-time bearer check. Mirrors `verifyWebhookToken` in the GitLab adapter:
 * compare lengths first, since `timingSafeEqual` throws on a length mismatch.
 */
export function isAuthorizedDrainRequest(
  authorizationHeader: string | undefined,
  expectedToken: string
): boolean {
  if (!authorizationHeader?.startsWith('Bearer ')) return false;
  const received = Buffer.from(authorizationHeader.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/**
 * @param replayParked Resumes parked chats. Cancelling drain calls it, so a deploy
 *   that fails before its swap hands parked work straight back to this server.
 */
export function registerInternalDrainRoutes(
  app: OpenAPIHono,
  lockManager: DrainTarget,
  token: string,
  replayParked: () => Promise<void>
): void {
  app.post('/internal/drain', async c => {
    if (!isAuthorizedDrainRequest(c.req.header('Authorization'), token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const parsed = drainRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: `budgetSeconds must be a number greater than 0 and at most ${MAX_DRAIN_BUDGET_SECONDS}`,
        },
        400
      );
    }
    const status = lockManager.beginDrain(parsed.data.budgetSeconds, parsed.data.graceSeconds);
    // WARN: the box has stopped accepting work. An operator reading startup logs
    // after a failed deploy needs to find this without grepping for debug lines.
    getLog().warn(
      { budgetSeconds: parsed.data.budgetSeconds, expiresAt: status.expiresAt },
      'internal.drain_requested'
    );
    return c.json(status);
  });

  app.delete('/internal/drain', async c => {
    if (!isAuthorizedDrainRequest(c.req.header('Authorization'), token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    // Idempotent: a deploy's failure path cancels blind, without having to know
    // whether its own drain request ever landed.
    lockManager.cancelDrain();
    getLog().warn('internal.drain_cancelled');
    // Un-park before answering, so the deploy's log can say the box is back as it
    // was. Each parked chat holds its new messages behind its replay meanwhile. A replay failure must never fail the cancel: the box is accepting work
    // again either way, and the next continuation tick retries the replay.
    try {
      await replayParked();
    } catch (error) {
      getLog().error({ err: error as Error }, 'internal.drain_cancel_replay_failed');
    }
    return c.json({ draining: false });
  });

  // Park what is still running so the deploy can swap. Parked runs are already
  // paused, and parked chats are excluded from the health `holding` counts, so
  // after this the drain waits only for what could not be parked.
  app.post('/internal/drain/park', async c => {
    if (!isAuthorizedDrainRequest(c.req.header('Authorization'), token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    try {
      const report = await parkForDeploy(lockManager);
      return c.json(report);
    } catch (error) {
      if (error instanceof NotDrainingError) return c.json({ error: error.message }, 409);
      getLog().error({ err: error as Error }, 'internal.drain_park_failed');
      return c.json({ error: 'park failed' }, 500);
    }
  });

  // What one drain parked and how much of it is back. Asked of the NEW server by
  // the deploy, for its report.
  app.get('/internal/drain/park/:drainId', async c => {
    if (!isAuthorizedDrainRequest(c.req.header('Authorization'), token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const drainId = drainIdSchema.safeParse(c.req.param('drainId'));
    if (!drainId.success) return c.json({ error: 'drainId must be a UUID' }, 400);
    try {
      return c.json(await summarizeDrain(drainId.data));
    } catch (error) {
      getLog().error({ err: error as Error }, 'internal.drain_park_summary_failed');
      return c.json({ error: 'could not read the park summary' }, 500);
    }
  });

  getLog().info('internal_drain_endpoint_registered');
}
