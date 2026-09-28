import { describe, test, expect, mock, beforeEach, beforeAll, afterAll } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import {
  makeListDashboardRunsMock,
  makeMockLockManager,
  mockAllWorkflowModules,
} from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must be declared before any dynamic imports of mocked modules
// ---------------------------------------------------------------------------

const mockGetCodebase = mock(
  async (_id: string) =>
    null as null | {
      id: string;
      name: string;
      repository_url: string | null;
      default_cwd: string;
      ai_assistant_type: string;
      commands: Record<string, unknown> | string;
      created_at: string;
      updated_at: string;
    }
);
type MockCodebase = Omit<typeof MOCK_CODEBASE, 'repository_url'> & {
  repository_url: string | null;
};
const mockListCodebases = mock(async () => [] as MockCodebase[]);
const mockDeleteCodebase = mock(async (_id: string) => {});
const mockUpdateCodebase = mock(
  async (_id: string, _data: { repository_url?: string | null }) => {}
);
const mockCloneRepository = mock(async (_url: string) => ({
  codebaseId: 'clone-uuid-1',
  alreadyExisted: false,
}));
const mockRegisterRepository = mock(async (_path: string) => ({
  codebaseId: 'register-uuid-1',
  alreadyExisted: false,
}));
const mockRegisterFolder = mock(async (_path: string) => ({
  codebaseId: 'folder-uuid-1',
  alreadyExisted: false,
}));
// Default: a resolvable repo root so local-path registration routes to
// registerRepository. Folder-fallback tests override this to resolve null.
const mockFindRepoRoot = mock(async (p: string) => p as string | null);
const mockListByCodebase = mock(async (_id: string) => [] as unknown[]);
const mockRemoveWorktree = mock(async () => {});
const mockListCheckoutFiles = mock(
  async (_cwd: string): Promise<{ paths: string[]; truncated: boolean }> => ({
    paths: [],
    truncated: false,
  })
);
class MockNotAGitCheckoutError extends Error {}
const mockUpdateStatus = mock(async (_id: string, _status: string) => {});

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  cloneRepository: mockCloneRepository,
  registerRepository: mockRegisterRepository,
  registerFolder: mockRegisterFolder,
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  generateAndSetTitle: mock(async () => {}),
  resolveTitleRequest: mock(async () => ({ provider: 'claude', options: {} })),
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
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mockRemoveWorktree,
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
  findRepoRoot: mockFindRepoRoot,
  listCheckoutFiles: mockListCheckoutFiles,
  NotAGitCheckoutError: MockNotAGitCheckoutError,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => ({
    id: 'internal-uuid-123',
    platform_conversation_id: 'web-test-abc',
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    platform_type: 'web',
    deleted_at: null,
    codebase_id: null,
  })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

class MockCodebaseNotFoundError extends Error {
  constructor(public codebaseId: string) {
    super(`Codebase ${codebaseId} not found`);
    this.name = 'CodebaseNotFoundError';
  }
}

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mockListCodebases,
  getCodebase: mockGetCodebase,
  deleteCodebase: mockDeleteCodebase,
  updateCodebase: mockUpdateCodebase,
  CodebaseNotFoundError: MockCodebaseNotFoundError,
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mockListByCodebase,
  updateStatus: mockUpdateStatus,
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: makeListDashboardRunsMock(),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'user',
    content: 'hello',
    metadata: '{}',
    created_at: new Date().toISOString(),
  })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findCommandFiles: mock(async () => []),
}));

// Import the module under test AFTER all mock.module() calls
import { registerApiRoutes } from './api';
import { removeTempTree } from '@archon/paths/test-utils';
import { mkdir, mkdtemp, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_CODEBASE = {
  id: 'codebase-uuid-1',
  name: 'my-project',
  repository_url: 'https://github.com/user/repo',
  default_cwd: '/home/user/projects/my-project',
  ai_assistant_type: 'claude',
  kind: 'repo',
  commands: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const MOCK_CODEBASE_WITH_STRING_COMMANDS = {
  ...MOCK_CODEBASE,
  id: 'codebase-uuid-2',
  commands: '{"plan":{"path":"/cmds/plan.md","description":"Plan"}}',
};

const MOCK_ENV = {
  id: 'env-uuid-1',
  codebase_id: 'codebase-uuid-1',
  working_path: '/tmp/worktrees/feature-branch',
  status: 'active',
  workflow_type: 'implement',
  workflow_id: 'wf-1',
  branch_name: 'feature-branch',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = makeMockLockManager();
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: GET /api/codebases
// ---------------------------------------------------------------------------

describe('GET /api/codebases', () => {
  beforeEach(() => {
    mockListCodebases.mockReset();
  });

  test('returns empty array when no codebases exist', async () => {
    mockListCodebases.mockImplementationOnce(async () => []);

    const app = makeApp();
    const response = await app.request('/api/codebases');
    expect(response.status).toBe(200);

    const body = (await response.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  test('returns list of codebases sorted by name', async () => {
    mockListCodebases.mockImplementationOnce(async () => [
      { ...MOCK_CODEBASE, id: 'b', name: 'zebra-project', repository_url: null },
      { ...MOCK_CODEBASE, id: 'a', name: 'alpha-project', repository_url: null },
    ]);

    const app = makeApp();
    const response = await app.request('/api/codebases');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ name: string }>;
    expect(body[0]?.name).toBe('alpha-project');
    expect(body[1]?.name).toBe('zebra-project');
  });

  test('deduplicates by repository_url (keeps most recently updated)', async () => {
    const older = {
      ...MOCK_CODEBASE,
      id: 'older',
      name: 'my-project',
      repository_url: 'https://github.com/user/repo',
      updated_at: '2024-01-01T00:00:00Z',
    };
    const newer = {
      ...MOCK_CODEBASE,
      id: 'newer',
      name: 'my-project',
      repository_url: 'https://github.com/user/repo.git',
      updated_at: '2024-06-01T00:00:00Z',
    };
    mockListCodebases.mockImplementationOnce(async () => [older, newer]);

    const app = makeApp();
    const response = await app.request('/api/codebases');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ id: string }>;
    // Only one entry should survive dedup (the newer one)
    expect(body.length).toBe(1);
    expect(body[0]?.id).toBe('newer');
  });

  test('parses commands when stored as JSON string', async () => {
    mockListCodebases.mockImplementationOnce(async () => [MOCK_CODEBASE_WITH_STRING_COMMANDS]);

    const app = makeApp();
    const response = await app.request('/api/codebases');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ commands: unknown }>;
    // Should be parsed object, not a string
    expect(typeof body[0]?.commands).toBe('object');
    expect(body[0]?.commands).not.toBeNull();
  });

  test('returns 500 when DB throws', async () => {
    mockListCodebases.mockImplementationOnce(async () => {
      throw new Error('DB unavailable');
    });

    const app = makeApp();
    const response = await app.request('/api/codebases');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to list codebases');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/codebases/:id
// ---------------------------------------------------------------------------

describe('GET /api/codebases/:id', () => {
  beforeEach(() => {
    mockGetCodebase.mockReset();
  });

  test('returns codebase when found', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { id: string; name: string };
    expect(body.id).toBe('codebase-uuid-1');
    expect(body.name).toBe('my-project');
  });

  test('returns 404 when codebase not found', async () => {
    mockGetCodebase.mockImplementationOnce(async () => null);

    const app = makeApp();
    const response = await app.request('/api/codebases/unknown-id');
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('parses commands when stored as JSON string', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE_WITH_STRING_COMMANDS);

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-2');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: unknown };
    expect(typeof body.commands).toBe('object');
    expect(body.commands).not.toBeNull();
  });

  test('returns empty commands object when JSON is corrupted', async () => {
    mockGetCodebase.mockImplementationOnce(async () => ({
      ...MOCK_CODEBASE,
      commands: '{not valid json',
    }));

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: unknown };
    expect(body.commands).toEqual({});
  });

  test('returns 500 when DB throws', async () => {
    mockGetCodebase.mockImplementationOnce(async () => {
      throw new Error('Connection error');
    });

    const app = makeApp();
    const response = await app.request('/api/codebases/any-id');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get codebase');
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/codebases
// ---------------------------------------------------------------------------

describe('POST /api/codebases', () => {
  beforeEach(() => {
    mockGetCodebase.mockReset();
    mockCloneRepository.mockReset();
    mockRegisterRepository.mockReset();
    mockRegisterFolder.mockReset();
    // Restore the default "resolvable repo root" so a local path routes to
    // registerRepository unless a test opts into the folder fallback.
    mockFindRepoRoot.mockReset();
    mockFindRepoRoot.mockImplementation(async (p: string) => p);
  });

  test('registers codebase by URL and returns 201', async () => {
    mockCloneRepository.mockImplementationOnce(async () => ({
      codebaseId: 'clone-uuid-1',
      alreadyExisted: false,
    }));
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/user/repo' }),
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { id: string };
    expect(body.id).toBe('codebase-uuid-1');
    expect(mockCloneRepository).toHaveBeenCalledWith('https://github.com/user/repo');
  });

  test('registers existing URL codebase with 200', async () => {
    mockCloneRepository.mockImplementationOnce(async () => ({
      codebaseId: 'clone-uuid-1',
      alreadyExisted: true,
    }));
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/user/repo' }),
    });
    expect(response.status).toBe(200);
  });

  test('registers codebase by local path and returns 201', async () => {
    mockRegisterRepository.mockImplementationOnce(async () => ({
      codebaseId: 'register-uuid-1',
      alreadyExisted: false,
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      ...MOCK_CODEBASE,
      id: 'register-uuid-1',
      repository_url: null,
    }));

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/home/user/my-repo' }),
    });
    expect(response.status).toBe(201);
    expect(mockRegisterRepository).toHaveBeenCalledWith('/home/user/my-repo');
    expect(mockRegisterFolder).not.toHaveBeenCalled();
  });

  test('registers a non-git path as a folder project and returns 201', async () => {
    // A path that is NOT a git repository → findRepoRoot resolves null → folder.
    mockFindRepoRoot.mockResolvedValueOnce(null);
    mockRegisterFolder.mockImplementationOnce(async () => ({
      codebaseId: 'folder-uuid-1',
      alreadyExisted: false,
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      ...MOCK_CODEBASE,
      id: 'folder-uuid-1',
      repository_url: null,
      kind: 'folder',
    }));

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/platform' }),
    });

    expect(response.status).toBe(201);
    expect(mockRegisterFolder).toHaveBeenCalledWith('/tmp/platform');
    expect(mockRegisterRepository).not.toHaveBeenCalled();
  });

  test('when findRepoRoot throws for a NONEXISTENT path, falls through to registerFolder for its clean error', async () => {
    // findRepoRoot throws for nonexistent paths. That case is benign: fall
    // through so registerFolder's own existence check produces the clean error.
    mockFindRepoRoot.mockRejectedValueOnce(new Error('git: command timed out'));
    mockRegisterFolder.mockImplementationOnce(async () => ({
      codebaseId: 'folder-uuid-2',
      alreadyExisted: false,
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      ...MOCK_CODEBASE,
      id: 'folder-uuid-2',
      repository_url: null,
      kind: 'folder',
    }));

    const app = makeApp();
    // Path must NOT exist on the test host (real existsSync decides the branch).
    const missingPath = '/nonexistent-archon-test/ambiguous';
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: missingPath }),
    });

    expect(response.status).toBe(201);
    expect(mockRegisterFolder).toHaveBeenCalledWith(missingPath);
    expect(mockRegisterRepository).not.toHaveBeenCalled();
  });

  test('when findRepoRoot throws for an EXISTING path, returns 500 and registers NOTHING', async () => {
    // A genuine git failure (git missing, timeout, permission) on a path that
    // exists is ambiguous — registering would permanently misclassify a real
    // repo as kind:'folder'. Fail fast instead.
    mockFindRepoRoot.mockRejectedValueOnce(new Error('git: command timed out'));

    const app = makeApp();
    // process.cwd() exists on every platform (real existsSync decides the branch).
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: process.cwd() }),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('git');
    expect(body.error).toContain('Nothing was registered');
    expect(mockRegisterFolder).not.toHaveBeenCalled();
    expect(mockRegisterRepository).not.toHaveBeenCalled();
  });

  test('returns 400 when both url and path are provided', async () => {
    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/x/y', path: '/local/path' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('url');
    expect(body.error).toContain('path');
  });

  test('returns 400 when neither url nor path are provided', async () => {
    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('url');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });
    expect(response.status).toBe(400);
  });

  test('returns 500 when codebase record not found after creation', async () => {
    mockCloneRepository.mockImplementationOnce(async () => ({
      codebaseId: 'clone-uuid-1',
      alreadyExisted: false,
    }));
    mockGetCodebase.mockImplementationOnce(async () => null);

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/user/repo' }),
    });
    expect(response.status).toBe(500);
  });

  test('returns 500 when clone throws an error', async () => {
    mockCloneRepository.mockImplementationOnce(async () => {
      throw new Error('git clone failed: authentication required');
    });

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/private/repo' }),
    });
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('authentication required');
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/codebases/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/codebases/:id', () => {
  beforeEach(() => {
    mockGetCodebase.mockReset();
    mockDeleteCodebase.mockReset();
    mockListByCodebase.mockReset();
    mockRemoveWorktree.mockReset();
    mockUpdateStatus.mockReset();
  });

  test('deletes codebase with no isolation environments and returns success', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);
    mockListByCodebase.mockImplementationOnce(async () => []);
    mockDeleteCodebase.mockImplementationOnce(async () => {});

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(mockDeleteCodebase).toHaveBeenCalledWith('codebase-uuid-1');
  });

  test('removes worktrees before deleting codebase', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);
    mockListByCodebase.mockImplementationOnce(async () => [MOCK_ENV]);
    mockRemoveWorktree.mockImplementationOnce(async () => {});
    mockUpdateStatus.mockImplementationOnce(async () => {});
    mockDeleteCodebase.mockImplementationOnce(async () => {});

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' });
    expect(response.status).toBe(200);

    // Worktree removal and status update should have been called
    expect(mockRemoveWorktree).toHaveBeenCalled();
    expect(mockUpdateStatus).toHaveBeenCalledWith('env-uuid-1', 'destroyed');
  });

  test('continues deletion even if worktree removal fails', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);
    mockListByCodebase.mockImplementationOnce(async () => [MOCK_ENV]);
    mockRemoveWorktree.mockImplementationOnce(async () => {
      throw new Error('worktree already gone');
    });
    mockUpdateStatus.mockImplementationOnce(async () => {});
    mockDeleteCodebase.mockImplementationOnce(async () => {});

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' });
    // Should still succeed — worktree removal failure is logged and skipped
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(mockDeleteCodebase).toHaveBeenCalled();
  });

  test('returns 404 when codebase not found', async () => {
    mockGetCodebase.mockImplementationOnce(async () => null);

    const app = makeApp();
    const response = await app.request('/api/codebases/unknown-id', { method: 'DELETE' });
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('does not delete disk directory for external (non-Archon-managed) repos', async () => {
    // The codebase's default_cwd is outside the Archon workspaces root
    mockGetCodebase.mockImplementationOnce(async () => ({
      ...MOCK_CODEBASE,
      default_cwd: '/home/user/my-external-repo',
    }));
    mockListByCodebase.mockImplementationOnce(async () => []);
    mockDeleteCodebase.mockImplementationOnce(async () => {});

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  test('returns 500 when DB delete throws', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);
    mockListByCodebase.mockImplementationOnce(async () => []);
    mockDeleteCodebase.mockImplementationOnce(async () => {
      throw new Error('FK constraint violation');
    });

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' });
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to delete codebase');
  });
});

// ---------------------------------------------------------------------------
// Tests: the Files tab endpoints (#23)
//
// Against a REAL temp tree, not a mocked fs. The whole point of these two
// routes is what the filesystem does with a path — symlink resolution above
// all — and a mocked fs would prove only that the mock agrees with itself.
// ---------------------------------------------------------------------------

describe('Files tab — GET /api/codebases/:id/files and /file', () => {
  let root: string;
  let outside: string;

  const asCodebase = (over: Record<string, unknown>): never =>
    ({ ...MOCK_CODEBASE, ...over }) as never;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'archon-files-root-'));
    outside = await mkdtemp(join(tmpdir(), 'archon-files-outside-'));

    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Title\n');
    await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
    await writeFile(join(root, 'src', 'nested', 'deep.ts'), 'export const deep = true;\n');
    // A NUL byte is the binary tell the read route refuses on.
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
    await writeFile(join(root, 'huge.txt'), 'x'.repeat(1024 * 1024 + 1));

    // The case that makes lexical containment insufficient: a link that is
    // inside the root and points out of it. Ordinary in a real repo.
    await writeFile(join(outside, 'secret.txt'), 'private key material\n');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  });

  afterAll(async () => {
    await removeTempTree(root);
    await removeTempTree(outside);
  });

  beforeEach(() => {
    mockGetCodebase.mockReset();
  });

  const listing = async (path = ''): Promise<Response> => {
    mockGetCodebase.mockImplementationOnce(async () => asCodebase({ default_cwd: root }));
    return makeApp().request(
      `/api/codebases/codebase-uuid-1/files?path=${encodeURIComponent(path)}`
    );
  };
  const read = async (path: string): Promise<Response> => {
    mockGetCodebase.mockImplementationOnce(async () => asCodebase({ default_cwd: root }));
    return makeApp().request(
      `/api/codebases/codebase-uuid-1/file?path=${encodeURIComponent(path)}`
    );
  };

  test('lists one directory, directories first', async () => {
    const response = await listing('');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      path: string;
      entries: { name: string; kind: string; size: number | null }[];
    };
    expect(body.path).toBe('');
    const names = body.entries.map(e => e.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    // Directories lead, so the tree reads without being scanned.
    expect(body.entries[0]?.name).toBe('src');
    expect(body.entries.find(e => e.name === 'src')?.kind).toBe('dir');
    expect(body.entries.find(e => e.name === 'README.md')?.size).toBe(8);
    expect(body.entries.find(e => e.name === 'src')?.size).toBeNull();
  });

  test('a directory listing is one level, never a walk', async () => {
    // The lazy invariant, proved by what the response CANNOT contain: no
    // nested name, and no separator in any entry.
    const body = (await (await listing('')).json()) as { entries: { name: string }[] };
    expect(body.entries.map(e => e.name)).not.toContain('deep.ts');
    expect(body.entries.every(e => !e.name.includes('/'))).toBe(true);

    const nested = (await (await listing('src')).json()) as {
      path: string;
      entries: { name: string }[];
    };
    expect(nested.path).toBe('src');
    expect(nested.entries.map(e => e.name)).toEqual(['nested', 'index.ts']);
  });

  test('nothing is filtered out of a listing', async () => {
    // Including the symlink. A tree that hides part of the disk is lying; the
    // read path is where an escape is refused, not the listing.
    const body = (await (await listing('')).json()) as { entries: { name: string }[] };
    expect(body.entries.map(e => e.name)).toContain('escape.txt');
  });

  test('reads a file', async () => {
    const response = await read('src/index.ts');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { path: string; content: string; size: number };
    expect(body.content).toBe('export const x = 1;\n');
    // Forward slashes on EVERY host. `normalize()` answers in the host's
    // separator, so this returned `src\index.ts` on Windows — the same file in
    // the same repo carrying a different identifier depending on which machine
    // served it. The files client joins this onto each listing entry to build
    // the child's path and sends it back, so the difference travelled.
    expect(body.path).toBe('src/index.ts');
    expect(body.size).toBe(20);
  });

  test('a nested listing names its directory with forward slashes', async () => {
    // The other half of the same value: `path` on a LISTING is what the client
    // joins child names onto. A host-native separator here would put one inside
    // every descendant path the client derives.
    const body = (await (await listing('src/nested')).json()) as { path: string };
    expect(body.path).toBe('src/nested');
  });

  test('a .. traversal is rejected, on both endpoints', async () => {
    expect((await read('../secret.txt')).status).toBe(400);
    expect((await read('src/../../secret.txt')).status).toBe(400);
    expect((await listing('..')).status).toBe(400);
  });

  test('a symlink pointing outside the project root is refused', async () => {
    // The link resolves; containment is what refuses it. Reported as 404 —
    // an attacker learns nothing about what is out there.
    const response = await read('escape.txt');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toContain('private key');
  });

  test('a binary file is refused rather than mangled into JSON', async () => {
    const response = await read('logo.png');
    expect(response.status).toBe(415);
    expect(((await response.json()) as { error: string }).error).toContain('Binary');
  });

  test('a file over the size ceiling is refused whole, not truncated', async () => {
    const response = await read('huge.txt');
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('bytes');
  });

  test('a folder-kind project resolves its root like a repo one', async () => {
    mockGetCodebase.mockImplementationOnce(async () =>
      asCodebase({ kind: 'folder', repository_url: null, default_cwd: root })
    );
    const response = await makeApp().request('/api/codebases/codebase-uuid-1/files?path=src');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: { name: string }[] };
    expect(body.entries.map(e => e.name)).toContain('index.ts');
  });

  test('an unknown project is 404, not a read of nothing', async () => {
    mockGetCodebase.mockImplementationOnce(async () => null);
    const response = await makeApp().request('/api/codebases/nope/files');
    expect(response.status).toBe(404);
  });

  test('a missing file is 404 and a directory is not read as a file', async () => {
    expect((await read('src/nope.ts')).status).toBe(404);
    expect((await read('src')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tests: writing a file (#23 phase 2)
//
// The conflict check is the reason this endpoint exists, so it is tested
// against a real file that really changes underneath the caller.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests: the file search list. Git's own listing is tested against real git
// in @archon/git; this is the route's translation of it.
// ---------------------------------------------------------------------------

describe('GET /api/codebases/:id/paths', () => {
  beforeEach(() => {
    mockGetCodebase.mockReset();
    mockListCheckoutFiles.mockReset();
  });

  test("lists the project root's files", async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE as never);
    mockListCheckoutFiles.mockImplementationOnce(async () => ({
      paths: ['README.md', 'src/index.ts'],
      truncated: false,
    }));

    const response = await makeApp().request('/api/codebases/codebase-uuid-1/paths');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      paths: ['README.md', 'src/index.ts'],
      truncated: false,
    });
    expect(mockListCheckoutFiles).toHaveBeenCalledWith(MOCK_CODEBASE.default_cwd);
  });

  test('a project that is not a git checkout is a 409 that says so', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE as never);
    mockListCheckoutFiles.mockImplementationOnce(async () => {
      throw new MockNotAGitCheckoutError(MOCK_CODEBASE.default_cwd);
    });

    const response = await makeApp().request('/api/codebases/codebase-uuid-1/paths');

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('git checkout');
  });

  test('an unknown project is 404', async () => {
    mockGetCodebase.mockImplementationOnce(async () => null);
    const response = await makeApp().request('/api/codebases/nope/paths');
    expect(response.status).toBe(404);
    expect(mockListCheckoutFiles).not.toHaveBeenCalled();
  });
});

describe('Files tab - PUT /api/codebases/:id/file', () => {
  let root: string;
  let outside: string;

  const asCodebase = (over: Record<string, unknown>): never =>
    ({ ...MOCK_CODEBASE, ...over }) as never;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'archon-write-root-'));
    outside = await mkdtemp(join(tmpdir(), 'archon-write-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'private\n');
  });

  afterAll(async () => {
    await removeTempTree(root);
    await removeTempTree(outside);
  });

  beforeEach(() => {
    mockGetCodebase.mockReset();
  });

  const read = async (path: string): Promise<Response> => {
    mockGetCodebase.mockImplementationOnce(async () => asCodebase({ default_cwd: root }));
    return makeApp().request(
      `/api/codebases/codebase-uuid-1/file?path=${encodeURIComponent(path)}`
    );
  };

  const write = async (path: string, content: string, etag: string): Promise<Response> => {
    mockGetCodebase.mockImplementationOnce(async () => asCodebase({ default_cwd: root }));
    return makeApp().request(
      `/api/codebases/codebase-uuid-1/file?path=${encodeURIComponent(path)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, etag }),
      }
    );
  };

  const etagOf = async (path: string): Promise<string> => {
    const body = (await (await read(path)).json()) as { etag: string };
    return body.etag;
  };

  test('a read carries a version token, and it changes when the bytes do', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n');
    const first = await etagOf('a.txt');
    expect(first).not.toBe('');

    await writeFile(join(root, 'a.txt'), 'two\n');
    expect(await etagOf('a.txt')).not.toBe(first);
  });

  test('writes the file, and returns the version it now has', async () => {
    await writeFile(join(root, 'b.txt'), 'before\n');
    const etag = await etagOf('b.txt');

    const response = await write('b.txt', 'after\n', etag);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { size: number; etag: string };
    expect(body.size).toBe(6);
    expect(body.etag).not.toBe(etag);
    expect(await Bun.file(join(root, 'b.txt')).text()).toBe('after\n');
  });

  test('a save against a stale version is refused, and changes nothing', async () => {
    // The case this endpoint exists for: read, something else writes, save.
    // Without the check the caller's save would discard the other write.
    await writeFile(join(root, 'c.txt'), 'original\n');
    const stale = await etagOf('c.txt');
    await writeFile(join(root, 'c.txt'), 'written by a run\n');

    const response = await write('c.txt', 'my edit\n', stale);
    expect(response.status).toBe(409);
    expect(await Bun.file(join(root, 'c.txt')).text()).toBe('written by a run\n');
  });

  test('a traversal and a symlink escape are refused on write too', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'escape-w.txt'));
    expect((await write('../secret.txt', 'x', 'any')).status).toBe(400);
    expect((await write('escape-w.txt', 'x', 'any')).status).toBe(404);
    // The refused write did not reach the file the link points at.
    expect(await Bun.file(join(outside, 'secret.txt')).text()).toBe('private\n');
  });

  test('a missing file is not created by a write', async () => {
    // Creating a file has no version to conflict with, so it is deliberately
    // not this route's job.
    expect((await write('does-not-exist.txt', 'x', 'any')).status).toBe(404);
  });

  test('binary content and oversized content are refused', async () => {
    await writeFile(join(root, 'd.txt'), 'ok\n');
    const etag = await etagOf('d.txt');
    expect((await write('d.txt', 'a\u0000b', etag)).status).toBe(415);
    expect((await write('d.txt', 'x'.repeat(1024 * 1024 + 1), etag)).status).toBe(413);
    // Neither refusal touched the file.
    expect(await Bun.file(join(root, 'd.txt')).text()).toBe('ok\n');
  });

  test('a missing etag is refused rather than treated as permission to overwrite', async () => {
    await writeFile(join(root, 'e.txt'), 'ok\n');
    mockGetCodebase.mockImplementationOnce(async () => asCodebase({ default_cwd: root }));
    const response = await makeApp().request('/api/codebases/codebase-uuid-1/file?path=e.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'overwritten' }),
    });
    expect(response.status).toBe(400);
    expect(await Bun.file(join(root, 'e.txt')).text()).toBe('ok\n');
  });

  test('a write leaves no temp file behind', async () => {
    await writeFile(join(root, 'f.txt'), 'one\n');
    const etag = await etagOf('f.txt');
    expect((await write('f.txt', 'two\n', etag)).status).toBe(200);

    const { readdir } = await import('fs/promises');
    const left = (await readdir(root)).filter(n => n.startsWith('.archon-write-'));
    expect(left).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: raw image bytes (#23 phase 3)
// ---------------------------------------------------------------------------

describe('Files tab - GET /api/codebases/:id/raw', () => {
  let root: string;
  let outside: string;

  const asCodebase = (over: Record<string, unknown>): never =>
    ({ ...MOCK_CODEBASE, ...over }) as never;

  // A one-pixel PNG. Real bytes, so the NUL check and the content type are
  // exercised against something a browser would actually accept.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'archon-raw-root-'));
    outside = await mkdtemp(join(tmpdir(), 'archon-raw-outside-'));
    await writeFile(join(root, 'logo.png'), PNG);
    await writeFile(join(root, 'notes.md'), '# hi\n');
    await writeFile(join(root, 'drawing.svg'), '<svg onload="alert(1)"></svg>');
    await writeFile(join(outside, 'secret.png'), PNG);
    await symlink(join(outside, 'secret.png'), join(root, 'escape.png'));
  });

  afterAll(async () => {
    await removeTempTree(root);
    await removeTempTree(outside);
  });

  beforeEach(() => {
    mockGetCodebase.mockReset();
  });

  const raw = async (path: string): Promise<Response> => {
    mockGetCodebase.mockImplementationOnce(async () => asCodebase({ default_cwd: root }));
    return makeApp().request(`/api/codebases/codebase-uuid-1/raw?path=${encodeURIComponent(path)}`);
  };

  test('serves an image with its own content type, and refuses to be sniffed', async () => {
    const response = await raw('logo.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    // A checkout changes under live runs, so a cached image would lie.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(PNG));
  });

  test('SVG is refused - it is a script-bearing document, not a picture', async () => {
    // Serving it from this origin would let a repo file run with the console's
    // cookies. It is text, so the editor shows it instead.
    const response = await raw('drawing.svg');
    expect(response.status).toBe(415);
  });

  test('a non-image is refused by type before the file is resolved', async () => {
    expect((await raw('notes.md')).status).toBe(415);
  });

  test('traversal and symlink escape are refused here too', async () => {
    expect((await raw('../secret.png')).status).toBe(400);
    expect((await raw('escape.png')).status).toBe(404);
  });

  test('a missing image is 404', async () => {
    expect((await raw('nope.png')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/codebases/:id
//
// `repository_url` used to be FILL-ONLY, and only from inside the clone path.
// The correction case is therefore the one that matters most here: a row with
// a WRONG url, not merely a null one, must be settable.
// ---------------------------------------------------------------------------

describe('PATCH /api/codebases/:id', () => {
  const patch = (id: string, body: unknown): Request =>
    new Request(`http://localhost/api/codebases/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    mockGetCodebase.mockReset();
    mockUpdateCodebase.mockReset();
  });

  test('corrects an existing wrong repository_url', async () => {
    const wrong = { ...MOCK_CODEBASE, repository_url: 'https://github.com/user/WRONG' };
    const right = { ...MOCK_CODEBASE, repository_url: 'https://github.com/user/right' };
    mockGetCodebase.mockImplementationOnce(async () => wrong);
    mockGetCodebase.mockImplementationOnce(async () => right);

    const response = await makeApp().request(
      patch('codebase-uuid-1', { repository_url: 'https://github.com/user/right' })
    );

    expect(response.status).toBe(200);
    expect(mockUpdateCodebase).toHaveBeenCalledWith('codebase-uuid-1', {
      repository_url: 'https://github.com/user/right',
    });
    const body = (await response.json()) as { repository_url: string };
    expect(body.repository_url).toBe('https://github.com/user/right');
  });

  test('fills a null repository_url', async () => {
    const empty = { ...MOCK_CODEBASE, repository_url: null };
    const filled = { ...MOCK_CODEBASE, repository_url: 'https://github.com/user/repo' };
    mockGetCodebase.mockImplementationOnce(async () => empty);
    mockGetCodebase.mockImplementationOnce(async () => filled);

    const response = await makeApp().request(
      patch('codebase-uuid-1', { repository_url: 'https://github.com/user/repo' })
    );

    expect(response.status).toBe(200);
    expect(mockUpdateCodebase).toHaveBeenCalledWith('codebase-uuid-1', {
      repository_url: 'https://github.com/user/repo',
    });
  });

  test('an explicit null clears the field, and reaches the db as null', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);
    mockGetCodebase.mockImplementationOnce(async () => ({
      ...MOCK_CODEBASE,
      repository_url: null,
    }));

    const response = await makeApp().request(patch('codebase-uuid-1', { repository_url: null }));

    expect(response.status).toBe(200);
    expect(mockUpdateCodebase).toHaveBeenCalledWith('codebase-uuid-1', { repository_url: null });
  });

  // The scp-like form has no scheme, so `z.string().url()` would reject it —
  // while `resolveIssueSource` reads it happily. Accepting it is the point.
  test('accepts an scp-like git remote', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);
    mockGetCodebase.mockImplementationOnce(async () => ({
      ...MOCK_CODEBASE,
      repository_url: 'git@github.com:user/repo.git',
    }));

    const response = await makeApp().request(
      patch('codebase-uuid-1', { repository_url: 'git@github.com:user/repo.git' })
    );

    expect(response.status).toBe(200);
  });

  test('rejects a non-URL string without persisting anything', async () => {
    mockGetCodebase.mockImplementation(async () => MOCK_CODEBASE);

    const response = await makeApp().request(
      patch('codebase-uuid-1', { repository_url: 'not a url' })
    );

    expect(response.status).toBe(400);
    expect(mockUpdateCodebase).not.toHaveBeenCalled();
  });

  test('rejects an empty body rather than writing nothing quietly', async () => {
    mockGetCodebase.mockImplementation(async () => MOCK_CODEBASE);

    const response = await makeApp().request(patch('codebase-uuid-1', {}));

    expect(response.status).toBe(400);
    expect(mockUpdateCodebase).not.toHaveBeenCalled();
  });

  test('404s for a codebase that does not exist, and writes nothing', async () => {
    mockGetCodebase.mockImplementation(async () => null);

    const response = await makeApp().request(
      patch('missing', { repository_url: 'https://github.com/user/repo' })
    );

    expect(response.status).toBe(404);
    expect(mockUpdateCodebase).not.toHaveBeenCalled();
  });
});
