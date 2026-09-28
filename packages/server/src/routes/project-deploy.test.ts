/**
 * The per-project deploy routes (#211, #226). The contract that matters most is
 * the refusal: setting up deploys, flipping Deploy on Merge, Deploy now and
 * Cancel deploy are a person's, and an agent — which can call the server
 * directly, with any header it likes — must be refused before anything changes.
 * The second is that each project's method decides which deploy acts: a
 * workflow project's buttons never reach the Archon host deploy.
 *
 * The Access check is the real one; only the key endpoint is faked, by serving
 * the test's own "team" key where Cloudflare's would be.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
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

const PROJECT = 'b3a1f0c2-1111-4222-8333-444455556666';
const CODEBASE = { id: PROJECT, name: 'archon', default_cwd: '/src' };
const SETTING = {
  codebaseId: PROJECT,
  method: 'archon-host',
  branch: 'dev',
  deployOnMerge: false,
  updatedAt: '2026-09-27T00:00:00Z',
  updatedBy: null,
};

const mockGetCodebase = mock(async (_id: string): Promise<unknown> => CODEBASE);
mock.module('@archon/core/db/codebases', () => ({ getCodebase: mockGetCodebase }));

const mockGetProjectDeploy = mock(async (_id: string): Promise<unknown> => SETTING);
const mockSetDeployOnMerge = mock(async (_id: string, on: boolean, _actor: string) => ({
  before: !on,
  after: { ...SETTING, deployOnMerge: on },
}));
const mockSetUp = mock(
  async (codebaseId: string, branch: string, workflowName: string, actor: string) =>
    ({
      codebaseId,
      method: 'workflow',
      branch,
      workflowName,
      deployOnMerge: false,
      updatedBy: actor,
    }) as unknown
);
mock.module('@archon/core/db/project-deploy', () => ({
  getProjectDeploy: mockGetProjectDeploy,
  setDeployOnMerge: mockSetDeployOnMerge,
  setUpWorkflowDeploy: mockSetUp,
}));

const WORKFLOW_SETTING = { ...SETTING, method: 'workflow', branch: 'main', workflowName: 'deploy' };
const mockDeployWorkflowNow = mock(
  async (..._args: unknown[]): Promise<unknown> => ({ ok: true, runId: 'run-1' })
);
const mockCancelWorkflowDeploy = mock(
  async (..._args: unknown[]): Promise<unknown> => ({ ok: true, runId: 'run-1' })
);
const mockWorkflowLog = mock(async (_id: string): Promise<unknown[]> => []);
const mockListWorkflows = mock(async (_c: unknown): Promise<string[]> => ['build', 'deploy']);
mock.module('../services/workflow-deploy', () => ({
  deployWorkflowNow: mockDeployWorkflowNow,
  cancelWorkflowDeploy: mockCancelWorkflowDeploy,
  getWorkflowDeployLog: mockWorkflowLog,
  getWorkflowDeployView: mock(async () => ({ method: 'workflow', deployOnMerge: false })),
  listDeployableWorkflows: mockListWorkflows,
  readDeploySetup: mock(async () => ({
    branch: 'main',
    workflows: ['build', 'deploy'],
    workflow: 'deploy',
  })),
}));

const mockDeployNow = mock(
  async (..._args: unknown[]): Promise<unknown> => ({
    ok: true,
    requestId: 'r',
  })
);
const mockCancelDeploy = mock(
  async (..._args: unknown[]): Promise<unknown> => ({
    ok: true,
    how: 'signalled',
  })
);
const mockDecidePolicy = mock(async (_q: unknown): Promise<string> => 'run');
mock.module('../services/deploy-control', () => ({
  deployNow: mockDeployNow,
  cancelDeploy: mockCancelDeploy,
  decidePolicy: mockDecidePolicy,
  getDeployLog: mock(async () => []),
  getProjectDeployView: mock(async () => ({ deployOnMerge: false })),
}));

import { registerDeployPolicyRoute, registerProjectDeployRoutes } from './project-deploy';
import { resetHumanPassCache } from '../services/human-pass';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'archon-app';

let teamKey: CryptoKeyPair;
let agentKey: CryptoKeyPair;
let teamJwk: { n?: string; e?: string };
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

const b64 = (v: unknown): string =>
  Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

async function pass(key: CryptoKey, email = 'you@example.com'): Promise<string> {
  const head = b64({ alg: 'RS256', kid: 'k1' });
  const body = b64({
    aud: [AUD],
    iss: `https://${TEAM}`,
    email,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${head}.${body}`)
  );
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}

const rsa = (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );

beforeAll(async () => {
  teamKey = await rsa();
  agentKey = await rsa();
  teamJwk = await crypto.subtle.exportKey('jwk', teamKey.publicKey);
  process.env.ARCHON_CF_ACCESS_TEAM_DOMAIN = TEAM;
  process.env.ARCHON_CF_ACCESS_AUD = AUD;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ kid: 'k1', kty: 'RSA', n: teamJwk.n, e: teamJwk.e }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  process.env = savedEnv;
});

beforeEach(() => {
  resetHumanPassCache();
  mockSetDeployOnMerge.mockClear();
  mockDeployNow.mockClear();
  mockCancelDeploy.mockClear();
  mockSetUp.mockClear();
  mockDeployWorkflowNow.mockClear();
  mockCancelWorkflowDeploy.mockClear();
});

function app(): OpenAPIHono {
  const a = new OpenAPIHono();
  registerProjectDeployRoutes(a, async () => ({ chats: 2, workflows: 1 }), null);
  registerDeployPolicyRoute(a, 'drain-token');
  return a;
}

const url = `/api/projects/${PROJECT}/deploy`;
const TIP = 'c'.repeat(40);

type Call = [method: string, body?: unknown];
const ACTIONS: Call[] = [
  ['PATCH', { deployOnMerge: true }],
  ['POST', { sha: TIP }],
  ['DELETE'],
  ['PUT', { branch: 'main', workflowName: 'deploy' }],
];

async function call([method, body]: Call, headers: Record<string, string>): Promise<Response> {
  return app().request(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function nothingChanged(): void {
  expect(mockSetDeployOnMerge).not.toHaveBeenCalled();
  expect(mockDeployNow).not.toHaveBeenCalled();
  expect(mockCancelDeploy).not.toHaveBeenCalled();
  expect(mockSetUp).not.toHaveBeenCalled();
  expect(mockDeployWorkflowNow).not.toHaveBeenCalled();
  expect(mockCancelWorkflowDeploy).not.toHaveBeenCalled();
}

describe('an agent cannot set up deploys, flip the toggle, Deploy now, or Cancel deploy', () => {
  for (const action of ACTIONS) {
    test(`${action[0]} with no Access pass is refused`, async () => {
      const res = await call(action, { 'X-Archon-User': 'ameet' });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { reason: string }).reason).toBe('no-pass');
      nothingChanged();
    });

    test(`${action[0]} with a pass the agent signed itself is refused`, async () => {
      const forged = await pass(agentKey.privateKey);
      const res = await call(action, { 'Cf-Access-Jwt-Assertion': forged });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { reason: string }).reason).toBe('invalid-pass');
      nothingChanged();
    });
  }
});

describe('a person with a verified pass', () => {
  test('flips the toggle, and is recorded as the one who did', async () => {
    const res = await call(ACTIONS[0]!, {
      'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey),
    });
    expect(res.status).toBe(200);
    expect(mockSetDeployOnMerge).toHaveBeenCalledWith(PROJECT, true, 'you@example.com');
  });

  test('presses Deploy now for the tip they were shown', async () => {
    const res = await call(ACTIONS[1]!, {
      'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey),
    });
    expect(res.status).toBe(202);
    expect(mockDeployNow.mock.calls[0]?.[2]).toBe(TIP);
    expect(mockDeployNow.mock.calls[0]?.[3]).toBe('you@example.com');
  });

  test('presses Cancel deploy', async () => {
    const res = await call(ACTIONS[2]!, {
      'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey),
    });
    expect(res.status).toBe(200);
    expect(mockCancelDeploy).toHaveBeenCalledWith(PROJECT, 'you@example.com');
  });
});

describe('reading the row', () => {
  test('a project with no deploy answers null, with what Set up deploys starts filled with', async () => {
    mockGetProjectDeploy.mockImplementationOnce(async () => null);
    const res = await app().request(url);
    expect(await res.json()).toEqual({
      deploy: null,
      setup: { branch: 'main', workflows: ['build', 'deploy'], workflow: 'deploy' },
      canAct: false,
    });
  });

  test('says whether this browser could act, without refusing the read', async () => {
    const res = await app().request(url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploy: { canAct: boolean; running: unknown } };
    expect(body.deploy.canAct).toBe(false);
    expect(body.deploy.running).toEqual({ chats: 2, workflows: 1 });
  });
});

describe('the host policy route', () => {
  test('needs the drain token', async () => {
    const res = await app().request('/internal/deploy-policy?method=archon-host');
    expect(res.status).toBe(401);
  });

  test('answers one machine token', async () => {
    mockDecidePolicy.mockImplementationOnce(async () => 'hold:toggle-off');
    const res = await app().request(
      `/internal/deploy-policy?method=archon-host&source=merge&sha=${TIP}`,
      { headers: { Authorization: 'Bearer drain-token' } }
    );
    expect(await res.text()).toBe('hold:toggle-off');
    expect(mockDecidePolicy).toHaveBeenLastCalledWith({
      source: 'merge',
      sha: TIP,
      request: undefined,
    });
  });
});

describe('Set up deploys', () => {
  async function setUp(body: unknown): Promise<Response> {
    return call(['PUT', body], { 'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey) });
  }

  test('creates the workflow deploy as the person who asked', async () => {
    const res = await setUp({ branch: ' main ', workflowName: 'deploy' });
    expect(res.status).toBe(201);
    expect(mockSetUp).toHaveBeenCalledTimes(1);
    expect(mockSetUp).toHaveBeenCalledWith(PROJECT, 'main', 'deploy', 'you@example.com');
    const body = (await res.json()) as { deploy: { deployOnMerge: boolean } };
    expect(body.deploy.deployOnMerge).toBe(false);
  });

  test('refuses a workflow the project does not have', async () => {
    const res = await setUp({ branch: 'main', workflowName: 'ship' });
    expect(res.status).toBe(400);
    expect(mockSetUp).not.toHaveBeenCalled();
  });

  test('refuses a missing branch', async () => {
    const res = await setUp({ branch: '', workflowName: 'deploy' });
    expect(res.status).toBe(400);
    expect(mockSetUp).not.toHaveBeenCalled();
  });

  test('refuses a project that already has a deploy', async () => {
    mockSetUp.mockImplementationOnce(async () => null);
    const res = await setUp({ branch: 'main', workflowName: 'deploy' });
    expect(res.status).toBe(409);
  });
});

describe('a workflow project acts on its own workflow, never the Archon host deploy', () => {
  beforeEach(() => {
    mockGetProjectDeploy.mockImplementation(async () => WORKFLOW_SETTING);
  });
  afterAll(() => {
    mockGetProjectDeploy.mockImplementation(async () => SETTING);
  });

  test('Deploy now starts the workflow for this project', async () => {
    const res = await call(ACTIONS[1]!, {
      'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey),
    });
    expect(res.status).toBe(202);
    expect(mockDeployNow).not.toHaveBeenCalled();
    const [codebase, setting, sha, email] = mockDeployWorkflowNow.mock.calls[0] ?? [];
    expect(codebase).toEqual(CODEBASE);
    expect(setting).toEqual(WORKFLOW_SETTING);
    expect(sha).toBe(TIP);
    expect(email).toBe('you@example.com');
  });

  test("Deploy now's refusal reaches the person", async () => {
    mockDeployWorkflowNow.mockImplementationOnce(async () => ({
      ok: false,
      status: 409,
      error: 'This project has no workflow named "deploy".',
    }));
    const res = await call(ACTIONS[1]!, {
      'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('no workflow');
  });

  test('Cancel deploy cancels this project run', async () => {
    const res = await call(ACTIONS[2]!, {
      'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey),
    });
    expect(res.status).toBe(200);
    expect(mockCancelDeploy).not.toHaveBeenCalled();
    expect(mockCancelWorkflowDeploy).toHaveBeenCalledWith(PROJECT, 'you@example.com');
  });

  test("the log is the project's own runs, not the host's deploy-history", async () => {
    const res = await app().request(`${url}/log`);
    expect(res.status).toBe(200);
    expect(mockWorkflowLog).toHaveBeenCalledWith(PROJECT);
  });
});
