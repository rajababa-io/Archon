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
  productionBranch: null,
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
type SetUpArgs = { branch: string; productionBranch: string | null; workflowName: string };
const mockSetUp = mock(
  async (codebaseId: string, setup: SetUpArgs, actor: string) =>
    ({
      codebaseId,
      method: 'workflow',
      ...setup,
      deployOnMerge: false,
      updatedBy: actor,
    }) as unknown
);
const mockUpdateSettings = mock(
  async (
    _id: string,
    change: Omit<SetUpArgs, 'workflowName'> & { workflowName: string | null },
    _actor: string
  ): Promise<unknown> => ({
    ...WORKFLOW_SETTING,
    ...change,
  })
);
const REMOTE_SETTING = {
  ...SETTING,
  method: 'remote-host',
  branch: 'main',
  deployOnMerge: true,
  remoteUrl: 'http://adina:8080/archon/deploy',
};
const mockFindRemote = mock(
  async (token: string): Promise<unknown> => (token === 'adina-credential' ? REMOTE_SETTING : null)
);
const mockRecordReport = mock(async (..._args: unknown[]): Promise<void> => undefined);
mock.module('@archon/core/db/project-deploy', () => ({
  getProjectDeploy: mockGetProjectDeploy,
  setDeployOnMerge: mockSetDeployOnMerge,
  setUpWorkflowDeploy: mockSetUp,
  updateDeploySettings: mockUpdateSettings,
  findRemoteDeployByToken: mockFindRemote,
  recordDeployReport: mockRecordReport,
  isDeployReportVerdict: (v: unknown) => v === 'held' || v === 'ok' || v === 'failed',
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
const mockDecideFor = mock(async (_s: unknown, _q: unknown): Promise<string> => 'run');
const mockResetWaiting = mock(() => undefined);
const mockReadBranches = mock(
  async (_c: unknown): Promise<unknown> => ({
    branches: { branches: ['main', 'production'], defaultBranch: 'main', complete: true },
    reason: null,
  })
);
mock.module('../services/deploy-control', () => ({
  readRemoteBranches: mockReadBranches,
  resetWaitingCache: mockResetWaiting,
  deployNow: mockDeployNow,
  cancelDeploy: mockCancelDeploy,
  decidePolicy: mockDecidePolicy,
  decideFor: mockDecideFor,
  getDeployLog: mock(async () => []),
  getProjectDeployView: mock(async () => ({ deployOnMerge: false })),
}));

const mockDeployRemoteNow = mock(
  async (..._args: unknown[]): Promise<unknown> => ({ ok: true, requestId: 'r' })
);
const mockRemoteLog = mock(async (_id: string): Promise<unknown[]> => []);
mock.module('../services/remote-deploy', () => ({
  deployRemoteNow: mockDeployRemoteNow,
  getRemoteDeployLog: mockRemoteLog,
  getRemoteDeployView: mock(async () => ({ method: 'remote-host', deployOnMerge: true })),
}));

import {
  registerDeployPolicyRoute,
  registerProjectDeployRoutes,
  registerRemoteDeployRoutes,
} from './project-deploy';
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
  mockUpdateSettings.mockClear();
  mockResetWaiting.mockClear();
  mockDeployWorkflowNow.mockClear();
  mockCancelWorkflowDeploy.mockClear();
  mockDeployRemoteNow.mockClear();
  mockRecordReport.mockClear();
  mockDecideFor.mockClear();
});

function app(): OpenAPIHono {
  const a = new OpenAPIHono();
  registerProjectDeployRoutes(a, async () => ({ chats: 2, workflows: 1 }), null);
  registerDeployPolicyRoute(a, 'drain-token');
  registerRemoteDeployRoutes(a);
  return a;
}

const url = `/api/projects/${PROJECT}/deploy`;
const TIP = 'c'.repeat(40);

type Call = [method: string, body?: unknown, path?: string];
const ACTIONS: Call[] = [
  ['PATCH', { deployOnMerge: true }],
  ['POST', { sha: TIP }],
  ['DELETE'],
  ['PUT', { branch: 'main', workflowName: 'deploy' }],
  ['PATCH', { branch: 'main', productionBranch: 'production' }, `${url}/settings`],
];

async function call(
  [method, body, path]: Call,
  headers: Record<string, string>
): Promise<Response> {
  return app().request(path ?? url, {
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
  expect(mockUpdateSettings).not.toHaveBeenCalled();
  expect(mockDeployWorkflowNow).not.toHaveBeenCalled();
  expect(mockCancelWorkflowDeploy).not.toHaveBeenCalled();
  expect(mockDeployRemoteNow).not.toHaveBeenCalled();
}

describe('an agent cannot set up deploys, flip the toggle, Deploy now, Cancel deploy, or change settings', () => {
  for (const action of ACTIONS) {
    test(`${action[0]} ${action[2] ?? url} with no Access pass is refused`, async () => {
      const res = await call(action, { 'X-Archon-User': 'ameet' });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { reason: string }).reason).toBe('no-pass');
      nothingChanged();
    });

    test(`${action[0]} ${action[2] ?? url} with a pass the agent signed itself is refused`, async () => {
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
    expect(mockSetUp).toHaveBeenCalledWith(
      PROJECT,
      { branch: 'main', productionBranch: null, workflowName: 'deploy' },
      'you@example.com'
    );
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

  test('records the production branch the person picked (#266)', async () => {
    const res = await setUp({
      branch: 'main',
      productionBranch: 'production',
      workflowName: 'deploy',
    });
    expect(res.status).toBe(201);
    expect(mockSetUp.mock.calls[0]?.[1]).toEqual({
      branch: 'main',
      productionBranch: 'production',
      workflowName: 'deploy',
    });
  });

  test('refuses a production branch that is the working branch', async () => {
    const res = await setUp({ branch: 'main', productionBranch: 'main', workflowName: 'deploy' });
    expect(res.status).toBe(400);
    expect(mockSetUp).not.toHaveBeenCalled();
  });

  test('refuses a project that already has a deploy', async () => {
    mockSetUp.mockImplementationOnce(async () => null);
    const res = await setUp({ branch: 'main', workflowName: 'deploy' });
    expect(res.status).toBe(409);
  });
});

describe("the deploy bar's settings (#266)", () => {
  const settingsUrl = `${url}/settings`;
  async function change(body: unknown): Promise<Response> {
    return call(['PATCH', body, settingsUrl], {
      'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey),
    });
  }
  afterAll(() => {
    mockGetProjectDeploy.mockImplementation(async () => SETTING);
  });

  test("changes a workflow project's branches and workflow, and the next read is fresh", async () => {
    mockGetProjectDeploy.mockImplementation(async () => WORKFLOW_SETTING);
    const res = await change({
      branch: 'main',
      productionBranch: 'production',
      workflowName: 'build',
    });
    expect(res.status).toBe(200);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      PROJECT,
      { branch: 'main', productionBranch: 'production', workflowName: 'build' },
      'you@example.com'
    );
    expect(mockResetWaiting).toHaveBeenCalled();
  });

  test('an empty production branch clears it', async () => {
    mockGetProjectDeploy.mockImplementation(async () => WORKFLOW_SETTING);
    await change({ branch: 'main', productionBranch: '', workflowName: 'deploy' });
    expect(mockUpdateSettings.mock.calls[0]?.[1]).toMatchObject({ productionBranch: null });
  });

  test('refuses a workflow the project does not have', async () => {
    mockGetProjectDeploy.mockImplementation(async () => WORKFLOW_SETTING);
    const res = await change({ branch: 'main', workflowName: 'ship' });
    expect(res.status).toBe(400);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  test('refuses a production branch that is the working branch', async () => {
    mockGetProjectDeploy.mockImplementation(async () => WORKFLOW_SETTING);
    const res = await change({ branch: 'main', productionBranch: 'main', workflowName: 'deploy' });
    expect(res.status).toBe(400);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  test('the host deploy takes a new branch but no production branch, and never its own pointer', async () => {
    mockGetProjectDeploy.mockImplementation(async () => SETTING);
    expect((await change({ branch: 'main', productionBranch: 'deploy' })).status).toBe(400);
    expect((await change({ branch: 'deploy' })).status).toBe(400);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
    expect((await change({ branch: 'main' })).status).toBe(200);
    expect(mockUpdateSettings.mock.calls[0]?.[1]).toEqual({
      branch: 'main',
      productionBranch: null,
      workflowName: null,
    });
  });
});

describe('the branch pickers (#267)', () => {
  test("lists the repository's branches, default first", async () => {
    const res = await app().request(`${url}/branches`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      branches: ['main', 'production'],
      defaultBranch: 'main',
      complete: true,
      reason: null,
    });
  });

  test('a repository it cannot read answers an empty list and why', async () => {
    mockReadBranches.mockImplementationOnce(async () => ({ branches: null, reason: 'no-token' }));
    expect(await (await app().request(`${url}/branches`)).json()).toEqual({
      branches: [],
      defaultBranch: null,
      complete: false,
      reason: 'no-token',
    });
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

describe('a remote-host project acts through its own host, never the Archon host deploy (#220)', () => {
  beforeEach(() => {
    mockGetProjectDeploy.mockImplementation(async () => REMOTE_SETTING);
  });
  afterAll(() => {
    mockGetProjectDeploy.mockImplementation(async () => SETTING);
  });

  test('Deploy now asks its host, as the person who pressed it', async () => {
    const res = await call(ACTIONS[1]!, {
      'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey),
    });
    expect(res.status).toBe(202);
    expect(mockDeployNow).not.toHaveBeenCalled();
    expect(mockDeployWorkflowNow).not.toHaveBeenCalled();
    const [, setting, sha, email] = mockDeployRemoteNow.mock.calls[0] ?? [];
    expect(setting).toEqual(REMOTE_SETTING);
    expect(sha).toBe(TIP);
    expect(email).toBe('you@example.com');
  });

  test('an agent pressing Deploy now is refused before the host is asked', async () => {
    const res = await call(ACTIONS[1]!, { 'X-Archon-User': 'ameet' });
    expect(res.status).toBe(403);
    expect(mockDeployRemoteNow).not.toHaveBeenCalled();
  });

  test('Cancel deploy refuses, and never reaches the Archon host deploy', async () => {
    const res = await call(ACTIONS[2]!, {
      'Cf-Access-Jwt-Assertion': await pass(teamKey.privateKey),
    });
    expect(res.status).toBe(409);
    expect(mockCancelDeploy).not.toHaveBeenCalled();
  });

  test("the log is the host's reports, not this install's deploy-history", async () => {
    const res = await app().request(`${url}/log`);
    expect(res.status).toBe(200);
    expect(mockRemoteLog).toHaveBeenCalledWith(PROJECT);
  });
});

describe('the remote host policy and report routes (#220)', () => {
  const AUTH = { Authorization: 'Bearer adina-credential' };

  test('a caller without the project credential is refused', async () => {
    for (const headers of [{}, { Authorization: 'Bearer drain-token' }] as Record<
      string,
      string
    >[]) {
      const res = await app().request(`/internal/remote-deploy/policy?source=merge&sha=${TIP}`, {
        headers,
      });
      expect(res.status).toBe(401);
    }
    expect(mockDecideFor).not.toHaveBeenCalled();
    const res = await app().request('/internal/remote-deploy/report', {
      method: 'POST',
      body: JSON.stringify({ verdict: 'ok', sha: TIP, live: TIP }),
    });
    expect(res.status).toBe(401);
    expect(mockRecordReport).not.toHaveBeenCalled();
  });

  test("answers the credential's own project, with the shared policy", async () => {
    mockDecideFor.mockImplementationOnce(async () => 'hold:toggle-off');
    const res = await app().request(`/internal/remote-deploy/policy?source=merge&sha=${TIP}`, {
      headers: AUTH,
    });
    expect(await res.text()).toBe('hold:toggle-off');
    expect(mockDecideFor).toHaveBeenLastCalledWith(REMOTE_SETTING, {
      source: 'merge',
      sha: TIP,
      request: undefined,
    });
  });

  test('a lookup that throws answers a hold, never run', async () => {
    mockFindRemote.mockImplementationOnce(async () => {
      throw new Error('db down');
    });
    const res = await app().request(`/internal/remote-deploy/policy?source=merge&sha=${TIP}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('hold:policy-error');
  });

  test('records a report against the credential project', async () => {
    const live = 'a'.repeat(40);
    const res = await app().request('/internal/remote-deploy/report', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ verdict: 'held', sha: TIP, live, reason: 'hold:toggle-off' }),
    });
    expect(res.status).toBe(204);
    expect(mockRecordReport).toHaveBeenCalledWith(PROJECT, {
      verdict: 'held',
      sha: TIP,
      liveSha: live,
      reason: 'hold:toggle-off',
    });
  });

  test('refuses a report it cannot read', async () => {
    for (const body of [
      { verdict: 'deployed', sha: TIP, live: TIP },
      { verdict: 'ok', sha: 'abc', live: TIP },
      { verdict: 'ok', sha: TIP },
    ]) {
      const res = await app().request('/internal/remote-deploy/report', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(mockRecordReport).not.toHaveBeenCalled();
  });
});
