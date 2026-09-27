import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  registerBuiltinProviders,
  clearRegistry,
  getRegistration,
  registerProvider,
} from '@archon/providers';
import type { WebAdapter } from '../adapters/web';
import { EFFORT_LADDER } from '@archon/paths/effort';
import { InvalidConfigError } from '@archon/core/config';
import {
  makeCommandValidationMock,
  makeDiscoverWorkflowsMock,
  makeListDashboardRunsMock,
  makeLoaderMock,
  makeMockLockManager,
} from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports
// ---------------------------------------------------------------------------

const DEFAULT_CHATS = {
  nudgeAtPercent: 40,
  handoffAtPercent: 50,
  autoHandoff: true,
  ciWaitAlarmMinutes: 20,
};
const mockLoadConfig = mock(async () => ({
  assistants: { claude: { model: 'sonnet' } },
  worktree: { baseBranch: 'main' },
  // `toSafeConfig` is the identity in this harness, so this is exactly what
  // PATCH /api/config/chats reads back as the thresholds already on file.
  chats: { ...DEFAULT_CHATS },
}));
const mockGetDatabaseType = mock(() => 'sqlite' as const);
const mockUpdateGlobalConfig = mock(async (_updates: unknown) => {});

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: mockGetDatabaseType,
  loadConfig: mockLoadConfig,
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  toSafeConfig: (config: unknown) => config,
  generateAndSetTitle: mock(async () => {}),
  resolveTitleRequest: mock(async () => ({ provider: 'claude', options: {} })),
  updateGlobalConfig: mockUpdateGlobalConfig,
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
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  isDocker: mock(() => false),
}));

mock.module('@archon/workflows/workflow-discovery', makeDiscoverWorkflowsMock);
mock.module('@archon/workflows/loader', makeLoaderMock);
mock.module('@archon/workflows/command-validation', makeCommandValidationMock);
mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: mock(() => false),
}));

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => null),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => []),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));
mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  listByCodebaseWithAge: mock(async () => []),
  updateStatus: mock(async () => {}),
}));
mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: makeListDashboardRunsMock(),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  getRunningWorkflows: mock(async () => []),
}));
mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));
mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => null),
  listMessages: mock(async () => []),
}));
mock.module('@archon/core/db/env-vars', () => ({
  getEnvVars: mock(async () => []),
  getEnvVarKeys: mock(async () => []),
  setEnvVar: mock(async () => {}),
  deleteEnvVar: mock(async () => {}),
}));
mock.module('@archon/core/utils/commands', () => ({
  findCommandFiles: mock(async () => []),
}));

// Bootstrap registry after mocks
clearRegistry();
registerBuiltinProviders();

import { registerApiRoutes } from './api';
import { providerListResponseSchema } from './schemas/provider.schemas';

type Hono = InstanceType<typeof OpenAPIHono>;

function makeApp(): Hono {
  const app = new OpenAPIHono();
  const mockWebAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = makeMockLockManager();
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: GET /api/providers
// ---------------------------------------------------------------------------

describe('GET /api/providers', () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
  });

  test('returns 200 with provider list', async () => {
    const response = await app.request('/api/providers');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: unknown[] };
    expect(body.providers).toBeDefined();
    expect(Array.isArray(body.providers)).toBe(true);
  });

  test('includes built-in providers', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: { id: string; builtIn: boolean }[];
    };
    const ids = body.providers.map(p => p.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(body.providers.every(p => p.builtIn)).toBe(true);
  });

  test('returns the shared effort ladder for effort-capable providers', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: { id: string; effortLevels?: string[] }[];
    };
    expect(body.providers.find(provider => provider.id === 'codex')?.effortLevels).toEqual([
      ...EFFORT_LADDER,
    ]);
  });

  test('returns correct shape per provider (no factory or isModelCompatible)', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: Record<string, unknown>[];
    };
    for (const provider of body.providers) {
      expect(provider).toHaveProperty('id');
      expect(provider).toHaveProperty('displayName');
      expect(provider).toHaveProperty('capabilities');
      expect(provider).toHaveProperty('builtIn');
      // Non-serializable fields must NOT leak
      expect(provider).not.toHaveProperty('factory');
      expect(provider).not.toHaveProperty('isModelCompatible');
    }
  });

  test('preserves absent reporting declarations from older providers', async () => {
    const existing = getRegistration('claude');
    const capabilities = { ...existing.capabilities };
    delete capabilities.tokenReporting;
    delete capabilities.stopReasonReporting;
    delete capabilities.turnCountReporting;
    delete capabilities.resolvedModelReporting;
    registerProvider({ ...existing, id: 'legacy-reporting', capabilities });
    try {
      const response = await app.request('/api/providers');
      const body: unknown = await response.json();
      const parsed = providerListResponseSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw parsed.error;
      const legacy = parsed.data.providers.find(provider => provider.id === 'legacy-reporting');
      if (!legacy) throw new Error('Legacy provider missing from response');
      expect(capabilities).toEqual(legacy.capabilities);
      expect(legacy?.capabilities).not.toHaveProperty('tokenReporting');
      expect(legacy?.capabilities).not.toHaveProperty('stopReasonReporting');
      expect(legacy?.capabilities).not.toHaveProperty('turnCountReporting');
      expect(legacy?.capabilities).not.toHaveProperty('resolvedModelReporting');
    } finally {
      clearRegistry();
      registerBuiltinProviders();
    }
  });

  test('reports the different execution metrics available from each provider', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: { id: string; capabilities: Record<string, unknown> }[];
    };
    expect(body.providers.find(provider => provider.id === 'claude')?.capabilities).toMatchObject({
      tokenReporting: true,
      costReporting: true,
      stopReasonReporting: true,
      turnCountReporting: true,
      resolvedModelReporting: true,
    });
    expect(body.providers.find(provider => provider.id === 'codex')?.capabilities).toMatchObject({
      tokenReporting: true,
      costReporting: false,
      stopReasonReporting: false,
      turnCountReporting: false,
      resolvedModelReporting: false,
    });
  });

  test('capabilities have expected boolean fields', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: {
        capabilities: Record<string, boolean> & {
          structuredOutput: 'enforced' | 'best-effort' | false;
        };
      }[];
    };
    const caps = body.providers[0].capabilities;
    expect(typeof caps.sessionResume).toBe('boolean');
    expect(typeof caps.mcp).toBe('boolean');
    expect(typeof caps.hooks).toBe('boolean');
    expect(typeof caps.costReporting).toBe('boolean');
    // structuredOutput is the tiered union, not a boolean.
    expect(['enforced', 'best-effort', false]).toContain(caps.structuredOutput);
  });
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/config/tiers (ungated — solo-OK)
// ---------------------------------------------------------------------------

describe('PATCH /api/config/tiers', () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockUpdateGlobalConfig.mockClear();
  });

  async function patch(tiers: unknown): Promise<Response> {
    return await app.request('/api/config/tiers', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiers }),
    });
  }

  test('sets a tier → 200 and calls updateGlobalConfig with a clean RawAliasEntry', async () => {
    const res = await patch({ large: { provider: 'claude', model: 'opus', effort: 'high' } });
    expect(res.status).toBe(200);
    expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { tiers: Record<string, unknown> };
    expect(arg.tiers.large).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
  });

  test('unknown provider → 400, no write', async () => {
    const res = await patch({ large: { provider: 'definitely-not-a-provider', model: 'x' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('invalid effort for the provider → 400, no write (not silently dropped)', async () => {
    const res = await patch({ large: { provider: 'claude', model: 'opus', effort: 'extreme' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('null tier value unsets (passes null through)', async () => {
    const res = await patch({ large: null });
    expect(res.status).toBe(200);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { tiers: Record<string, unknown> };
    expect(arg.tiers.large).toBeNull();
  });

  test('rejects retired thinking config and names effort', async () => {
    const res = await patch({
      small: { provider: 'claude', model: 'haiku', thinking: { level: 'high' } },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('effort:');
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('is ungated — succeeds with no auth identity', async () => {
    // No X-Archon-User header, web auth disabled in the harness → still 200.
    const res = await patch({ medium: { provider: 'claude', model: 'sonnet' } });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/config/aliases (ungated — solo-OK; mirrors /tiers)
// ---------------------------------------------------------------------------

describe('PATCH /api/config/aliases', () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockUpdateGlobalConfig.mockClear();
  });

  async function patch(aliases: unknown): Promise<Response> {
    return await app.request('/api/config/aliases', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliases }),
    });
  }

  test('sets an alias → 200 and calls updateGlobalConfig with a clean entry', async () => {
    const res = await patch({ '@fast': { provider: 'claude', model: 'haiku', effort: 'low' } });
    expect(res.status).toBe(200);
    expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { aliases: Record<string, unknown> };
    expect(arg.aliases['@fast']).toEqual({ provider: 'claude', model: 'haiku', effort: 'low' });
  });

  test('reserved tier name as alias → 400, no write', async () => {
    const res = await patch({ large: { provider: 'claude', model: 'opus' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('alias without @ prefix → 400, no write', async () => {
    const res = await patch({ fast: { provider: 'claude', model: 'haiku' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('unknown provider → 400, no write', async () => {
    const res = await patch({ '@fast': { provider: 'definitely-not-a-provider', model: 'x' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('invalid effort for the provider → 400, no write', async () => {
    const res = await patch({ '@fast': { provider: 'claude', model: 'haiku', effort: 'extreme' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('null alias value unsets (passes null through)', async () => {
    const res = await patch({ '@fast': null });
    expect(res.status).toBe(200);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { aliases: Record<string, unknown> };
    expect(arg.aliases['@fast']).toBeNull();
  });

  test('rejects retired thinking config and names effort', async () => {
    const res = await patch({
      '@deep': { provider: 'claude', model: 'opus', thinking: { level: 'high' } },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('effort:');
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('is ungated — succeeds with no auth identity', async () => {
    const res = await patch({ '@fast': { provider: 'claude', model: 'haiku' } });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/config/chats (ungated — solo-OK; mirrors /tiers)
// ---------------------------------------------------------------------------

describe('PATCH /api/config/chats', () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockUpdateGlobalConfig.mockClear();
    mockLoadConfig.mockImplementation(async () => ({
      assistants: { claude: { model: 'sonnet' } },
      worktree: { baseBranch: 'main' },
      chats: { ...DEFAULT_CHATS },
    }));
  });

  /** Pretend the file already holds these thresholds. */
  function onFile(chats: typeof DEFAULT_CHATS): void {
    mockLoadConfig.mockImplementation(async () => ({
      assistants: { claude: { model: 'sonnet' } },
      worktree: { baseBranch: 'main' },
      chats,
    }));
  }

  async function patch(body: unknown): Promise<Response> {
    return await app.request('/api/config/chats', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('sets the thresholds → 200, passed through untouched', async () => {
    const res = await patch({ nudgeAtPercent: 35, handoffAtPercent: 55, autoHandoff: false });
    expect(res.status).toBe(200);
    expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { chats: Record<string, unknown> };
    expect(arg.chats).toEqual({ nudgeAtPercent: 35, handoffAtPercent: 55, autoHandoff: false });
  });

  test('a single field is a partial write, not a reset of the other two', async () => {
    const res = await patch({ autoHandoff: false });
    expect(res.status).toBe(200);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { chats: Record<string, unknown> };
    expect(arg.chats).toEqual({ autoHandoff: false });
  });

  test('a threshold outside 1-99 → 400, no write', async () => {
    // `resolveChatsConfig` would silently swap both of these for the default,
    // so accepting them here stores a number the engine ignores.
    expect((await patch({ handoffAtPercent: 0 })).status).toBe(400);
    expect((await patch({ handoffAtPercent: 100 })).status).toBe(400);
    expect((await patch({ nudgeAtPercent: 12.5 })).status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('the CI wait alarm saves in whole minutes up to the 24-hour expiry', async () => {
    expect((await patch({ ciWaitAlarmMinutes: 30 })).status).toBe(200);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { chats: Record<string, unknown> };
    expect(arg.chats).toEqual({ ciWaitAlarmMinutes: 30 });
    mockUpdateGlobalConfig.mockClear();
    // Each of these is a number the resolver would swap for the default.
    expect((await patch({ ciWaitAlarmMinutes: 0 })).status).toBe(400);
    expect((await patch({ ciWaitAlarmMinutes: 1441 })).status).toBe(400);
    expect((await patch({ ciWaitAlarmMinutes: 2.5 })).status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('a nudge at or above the handoff point → 400, no write', async () => {
    const res = await patch({ nudgeAtPercent: 60, handoffAtPercent: 55 });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('must be below the handoff point');
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('equal is also refused — the nudge would announce what just happened', async () => {
    const res = await patch({ nudgeAtPercent: 50, handoffAtPercent: 50 });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('the order rule is checked against the MERGED pair, not the body alone', async () => {
    // Raising only the nudge is valid in isolation and invalid against the
    // handoff point already on file. Checking the body alone would let the
    // pair be walked into an unusable state one field per request.
    onFile({ ...DEFAULT_CHATS, nudgeAtPercent: 40, handoffAtPercent: 50 });
    const res = await patch({ nudgeAtPercent: 70 });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('a lone nudge below the stored handoff point is allowed', async () => {
    onFile({ ...DEFAULT_CHATS, nudgeAtPercent: 40, handoffAtPercent: 80 });
    const res = await patch({ nudgeAtPercent: 70 });
    expect(res.status).toBe(200);
    expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1);
  });

  test('is ungated — succeeds with no auth identity', async () => {
    const res = await patch({ autoHandoff: true });
    expect(res.status).toBe(200);
  });
});

// Tests: a config write the loader refuses reaches the caller as a 400
// ---------------------------------------------------------------------------

describe('PATCH /api/config/* refused by config validation', () => {
  let app: Hono;
  const refused = new InvalidConfigError(
    'Invalid model binding config',
    '/home/operator/.archon/config.yaml',
    'tiers.large.model: Required'
  );

  beforeEach(() => {
    app = makeApp();
    mockUpdateGlobalConfig.mockClear();
  });

  afterEach(() => {
    mockUpdateGlobalConfig.mockImplementation(async () => {});
  });

  async function patch(path: string, body: unknown): Promise<Response> {
    return await app.request(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test.each([
    ['/api/config/assistants', { assistants: { codex: { model: 'gpt-5.6-sol' } } }],
    ['/api/config/tiers', { tiers: { small: { provider: 'claude', model: 'haiku' } } }],
    ['/api/config/aliases', { aliases: { '@fast': { provider: 'claude', model: 'haiku' } } }],
  ])('%s → 400 naming the refused key, without the server path', async (path, body) => {
    mockUpdateGlobalConfig.mockImplementation(async () => {
      throw refused;
    });

    const res = await patch(path, body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Invalid model binding config: tiers.large.model: Required',
    });
  });

  test('a genuine write failure stays a 500', async () => {
    mockUpdateGlobalConfig.mockImplementation(async () => {
      throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    });

    const res = await patch('/api/config/tiers', {
      tiers: { small: { provider: 'claude', model: 'haiku' } },
    });

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('Permission denied');
  });
});
