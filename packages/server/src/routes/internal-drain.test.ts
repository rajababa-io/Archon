import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

class NotDrainingError extends Error {}
const mockParkForDeploy = mock(async (): Promise<unknown> => PARK_REPORT);
mock.module('../services/deploy-park', () => ({
  NotDrainingError,
  parkForDeploy: mockParkForDeploy,
}));
const mockSummarizeDrain = mock(async (_drainId: string): Promise<unknown> => PARK_SUMMARY);
mock.module('@archon/core/db/parked-work', () => ({ summarizeDrain: mockSummarizeDrain }));

const DRAIN_ID = '0b7c7f43-6a4e-4c1b-9d59-3f6f2d1c8a10';
const PARK_REPORT = {
  drainId: DRAIN_ID,
  parked: { chats: 3, queuedMessages: 1, runs: 1 },
  blocked: [{ kind: 'run', id: 'cli-run', reason: 'not_owned_by_this_server' }],
};
const PARK_SUMMARY = {
  parked: { chats: 3, queuedMessages: 1, runs: 1 },
  resumed: { chats: 3, queuedMessages: 1, runs: 0 },
};

import {
  isAuthorizedDrainRequest,
  MAX_DRAIN_BUDGET_SECONDS,
  registerInternalDrainRoutes,
  type DrainTarget,
} from './internal-drain';

const TOKEN = 'drain-token-value';

const DRAIN_STATUS = {
  requestedAt: '2026-09-23T19:00:00.000Z',
  expiresAt: '2026-09-23T19:30:00.000Z',
  refusedCount: 0,
};

function makeApp(replayParked: () => Promise<void> = mock(async () => {})): {
  app: OpenAPIHono;
  target: DrainTarget;
} {
  const app = new OpenAPIHono();
  const target = {
    beginDrain: mock(() => DRAIN_STATUS),
    cancelDrain: mock(() => {}),
  } as unknown as DrainTarget;
  registerInternalDrainRoutes(app, target, TOKEN, new Map(), replayParked);
  return { app, target };
}

async function post(
  app: OpenAPIHono,
  body: unknown,
  authorization = `Bearer ${TOKEN}`
): Promise<Response> {
  return await app.request('/internal/drain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify(body),
  });
}

describe('isAuthorizedDrainRequest', () => {
  test('accepts the configured token', () => {
    expect(isAuthorizedDrainRequest(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  test('rejects a wrong token of the same length', () => {
    const wrong = 'x'.repeat(TOKEN.length);
    expect(wrong.length).toBe(TOKEN.length);
    expect(isAuthorizedDrainRequest(`Bearer ${wrong}`, TOKEN)).toBe(false);
  });

  // timingSafeEqual throws on a length mismatch, so the length check is not an
  // optimization — without it a short token is a 500 rather than a 401.
  test('rejects a token of a different length', () => {
    expect(isAuthorizedDrainRequest('Bearer short', TOKEN)).toBe(false);
    expect(isAuthorizedDrainRequest(`Bearer ${TOKEN}extra`, TOKEN)).toBe(false);
  });

  test('rejects a missing or non-Bearer header', () => {
    expect(isAuthorizedDrainRequest(undefined, TOKEN)).toBe(false);
    expect(isAuthorizedDrainRequest('', TOKEN)).toBe(false);
    expect(isAuthorizedDrainRequest(TOKEN, TOKEN)).toBe(false);
    expect(isAuthorizedDrainRequest(`Basic ${TOKEN}`, TOKEN)).toBe(false);
  });
});

describe('POST /internal/drain', () => {
  test('begins drain and returns the status', async () => {
    const { app, target } = makeApp();
    const response = await post(app, { budgetSeconds: 600 });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DRAIN_STATUS);
    expect(target.beginDrain).toHaveBeenCalledWith(600, undefined);
  });

  test('passes the grace the deploy declared through to the lock manager (#211)', async () => {
    const { app, target } = makeApp();
    const response = await post(app, { budgetSeconds: 1800, graceSeconds: 600 });

    expect(response.status).toBe(200);
    expect(target.beginDrain).toHaveBeenCalledWith(1800, 600);
  });

  test('refuses an unauthorized caller without touching the lock manager', async () => {
    const { app, target } = makeApp();
    const response = await post(app, { budgetSeconds: 600 }, 'Bearer wrong-token-value');

    expect(response.status).toBe(401);
    expect(target.beginDrain).not.toHaveBeenCalled();
  });

  // A budget that cannot expire is a box that never accepts work again.
  test('refuses a budget outside the allowed range', async () => {
    for (const budgetSeconds of [0, -1, MAX_DRAIN_BUDGET_SECONDS + 1]) {
      const { app, target } = makeApp();
      const response = await post(app, { budgetSeconds });
      expect(response.status).toBe(400);
      expect(target.beginDrain).not.toHaveBeenCalled();
    }
  });

  test('refuses a missing or non-numeric budget', async () => {
    for (const body of [{}, { budgetSeconds: '600' }, { budgetSeconds: null }, null]) {
      const { app, target } = makeApp();
      const response = await post(app, body);
      expect(response.status).toBe(400);
      expect(target.beginDrain).not.toHaveBeenCalled();
    }
  });

  test('accepts the range boundaries', async () => {
    for (const budgetSeconds of [1, MAX_DRAIN_BUDGET_SECONDS]) {
      const { app, target } = makeApp();
      const response = await post(app, { budgetSeconds });
      expect(response.status).toBe(200);
      expect(target.beginDrain).toHaveBeenCalledWith(budgetSeconds, undefined);
    }
  });
});

describe('DELETE /internal/drain', () => {
  const del = async (app: OpenAPIHono, authorization = `Bearer ${TOKEN}`): Promise<Response> =>
    await app.request('/internal/drain', {
      method: 'DELETE',
      headers: { Authorization: authorization },
    });

  // The deploy's failure path cancels blind, so cancelling a drain that never
  // started has to succeed rather than report an error the script would escalate.
  test('cancels and is idempotent', async () => {
    const { app, target } = makeApp();
    expect((await del(app)).status).toBe(200);
    expect(await (await del(app)).json()).toEqual({ draining: false });
    expect(target.cancelDrain).toHaveBeenCalledTimes(2);
  });

  test('refuses an unauthorized caller', async () => {
    const { app, target } = makeApp();
    expect((await del(app, 'Bearer wrong-token-value')).status).toBe(401);
    expect(target.cancelDrain).not.toHaveBeenCalled();
  });
});

describe('DELETE /internal/drain hands parked work back', () => {
  const del = async (app: OpenAPIHono): Promise<Response> =>
    await app.request('/internal/drain', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

  // A deploy that fails before its swap cancels drain; that cancel is the un-park.
  test('replays parked work after cancelling, before answering', async () => {
    const order: string[] = [];
    const replay = mock(async () => {
      order.push('replay');
    });
    const { app, target } = makeApp(replay);
    (target.cancelDrain as ReturnType<typeof mock>).mockImplementation(() => {
      order.push('cancel');
    });

    expect((await del(app)).status).toBe(200);
    expect(order).toEqual(['cancel', 'replay']);
  });

  test('a replay that fails never fails the cancel', async () => {
    const { app } = makeApp(
      mock(async () => {
        throw new Error('db down');
      })
    );
    const response = await del(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ draining: false });
  });
});

describe('POST /internal/drain/park', () => {
  const park = async (app: OpenAPIHono, authorization = `Bearer ${TOKEN}`): Promise<Response> =>
    await app.request('/internal/drain/park', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: '{}',
    });

  test('answers with what was parked and what keeps the deploy waiting', async () => {
    const { app } = makeApp();
    const response = await park(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PARK_REPORT);
  });

  test('refuses an unauthorized caller without parking anything', async () => {
    mockParkForDeploy.mockClear();
    const { app } = makeApp();
    expect((await park(app, 'Bearer wrong-token-value')).status).toBe(401);
    expect(mockParkForDeploy).not.toHaveBeenCalled();
  });

  // Parked work is replayed whenever the server is not draining, so parking
  // without a drain would be undone at the next tick.
  test('is a 409 when the server is not draining', async () => {
    mockParkForDeploy.mockImplementationOnce(async () => {
      throw new NotDrainingError('not draining');
    });
    const { app } = makeApp();
    expect((await park(app)).status).toBe(409);
  });

  test('any other failure is a 500 the deploy stops on', async () => {
    mockParkForDeploy.mockImplementationOnce(async () => {
      throw new Error('db down');
    });
    const { app } = makeApp();
    expect((await park(app)).status).toBe(500);
  });
});

describe('GET /internal/drain/park/:drainId', () => {
  const get = async (
    app: OpenAPIHono,
    drainId: string,
    authorization = `Bearer ${TOKEN}`
  ): Promise<Response> =>
    await app.request(`/internal/drain/park/${drainId}`, {
      headers: { Authorization: authorization },
    });

  test('reports what the drain parked and how much has resumed', async () => {
    const { app } = makeApp();
    const response = await get(app, DRAIN_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PARK_SUMMARY);
    expect(mockSummarizeDrain).toHaveBeenLastCalledWith(DRAIN_ID);
  });

  test('refuses a drain id that is not a UUID', async () => {
    const { app } = makeApp();
    expect((await get(app, 'not-a-uuid')).status).toBe(400);
  });

  test('refuses an unauthorized caller', async () => {
    const { app } = makeApp();
    expect((await get(app, DRAIN_ID, 'Bearer wrong-token-value')).status).toBe(401);
  });
});
