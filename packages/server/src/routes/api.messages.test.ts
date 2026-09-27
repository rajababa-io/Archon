import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import {
  makeListDashboardRunsMock,
  makeMockLockManager,
  mockAllWorkflowModules,
} from '../test/workflow-mock-factories';
import { MAX_TOOL_OUTPUT_CHARS } from '../adapters/web/truncate';

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports of mocked modules
// ---------------------------------------------------------------------------

const mockFindConversationByPlatformId = mock(
  async (_id: string) =>
    null as null | {
      id: string;
      platform_conversation_id: string;
      title: string | null;
      ai_assistant_type: string;
      created_at: Date;
      updated_at: Date;
      platform_type: string;
      deleted_at: Date | null;
      codebase_id: string | null;
    }
);
const mockUpdateConversationTitle = mock(async (_id: string, _title: string) => {});
const mockAddMessage = mock(
  async (_conversationId: string, _role: 'user' | 'assistant', _content: string) => ({
    id: 'msg-uuid-1',
    conversation_id: _conversationId,
    role: _role,
    content: _content,
    metadata: '{}',
    user_id: null,
    created_at: new Date().toISOString(),
  })
);
const mockListMessages = mock<(typeof import('@archon/core/db/messages'))['listMessages']>(
  async () => []
);
const mockHandleMessage = mock(async () => {});

mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
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
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mockFindConversationByPlatformId,
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
    ai_assistant_type: 'claude',
  })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mockUpdateConversationTitle,
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
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
  addMessage: mockAddMessage,
  listMessages: mockListMessages,
}));

mock.module('@archon/core/utils/commands', () => ({
  findCommandFiles: mock(async () => []),
}));

import { registerApiRoutes } from './api';
import { ConversationLockManager as RealLockManager } from '@archon/core/utils/conversation-lock';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_CONV = {
  id: 'internal-uuid-123',
  platform_conversation_id: 'web-test-abc',
  title: null,
  ai_assistant_type: 'claude',
  created_at: new Date(),
  updated_at: new Date(),
  platform_type: 'web',
  deleted_at: null,
  codebase_id: null,
};

const MOCK_MESSAGES = [
  {
    id: 'msg-1',
    conversation_id: 'internal-uuid-123',
    role: 'user' as const,
    content: 'Hello there',
    metadata: '{}',
    user_id: null,
    created_at: new Date().toISOString(),
  },
  {
    id: 'msg-2',
    conversation_id: 'internal-uuid-123',
    role: 'assistant' as const,
    content: 'Hi! How can I help?',
    metadata: '{"toolCalls":[]}',
    user_id: null,
    created_at: new Date().toISOString(),
  },
];

function makeApp(lockManagerOverrides: Partial<ConversationLockManager> = {}): {
  app: OpenAPIHono;
  mockWebAdapter: WebAdapter;
  mockLockManager: ConversationLockManager;
} {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = makeMockLockManager(lockManagerOverrides);
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return { app, mockWebAdapter, mockLockManager };
}

// ---------------------------------------------------------------------------
// Tests: POST /api/conversations/:id/message
// ---------------------------------------------------------------------------

describe('POST /api/conversations/:id/message', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockHandleMessage.mockReset();
    mockAddMessage.mockReset();
  });

  test('accepts a valid message and dispatches to orchestrator', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Hello',
      metadata: '{}',
      user_id: null,
      created_at: new Date().toISOString(),
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { accepted: boolean; status: string };
    expect(body.accepted).toBe(true);
    expect(body.status).toBe('started');
  });

  // Invariant: a message that arrives during drain must never be silently dropped.
  // Refusal (not a queue) is the choice: the queue is in-memory and the process is
  // about to be replaced, so a queued message would be lost by the swap.
  test('refuses a message with 503 while draining, without acquiring the lock', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    const acquireLock = mock(async () => ({ status: 'refused-draining' as const }));

    const { app } = makeApp({ acquireLock, isDraining: mock(() => true) });
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
    // The caller was told, and the turn never started.
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('persists user message to DB when conversation is found', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Test message',
      metadata: '{}',
      user_id: null,
      created_at: new Date().toISOString(),
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Test message' }),
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      MOCK_CONV.id,
      'user',
      'Test message',
      undefined,
      undefined
    );
  });

  test('still dispatches when conversation lookup fails (no message persistence)', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/conversations/unknown-conv/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    // Should still return accepted — message is sent even without persistence
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
    // addMessage should NOT be called when conversation is not found
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  test('returns 400 when message is empty string', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('message');
  });

  test('returns 400 when message field is missing', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    // Zod validation returns "message: Required" before the handler runs
    expect(body.error).toContain('message');
  });

  test('returns 400 for malformed JSON body', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json{',
    });
    expect(response.status).toBe(400);
  });

  test('returns 400 when message is a non-string type', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 42 }),
    });
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/conversations/:id/messages
// ---------------------------------------------------------------------------

describe('GET /api/conversations/:id/messages', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockListMessages.mockReset();
  });

  test('returns message history for a conversation', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => MOCK_MESSAGES);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ id: string; role: string; content: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    expect(body[0]?.role).toBe('user');
    expect(body[1]?.role).toBe('assistant');
  });

  test('uses conversation DB id when querying messages', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/conversations/web-test-abc/messages');

    expect(mockListMessages).toHaveBeenCalledWith(MOCK_CONV.id, expect.any(Number));
  });

  test('normalizes JSONB metadata (object) to JSON string', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => [
      {
        id: 'msg-1',
        conversation_id: MOCK_CONV.id,
        role: 'assistant' as const,
        content: 'Response',
        // Simulate PostgreSQL returning JSONB as an object
        metadata: { toolCalls: [{ name: 'bash' }] } as unknown as string,
        user_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ metadata: string }>;
    // Metadata should be serialized to JSON string for frontend consumption
    expect(typeof body[0]?.metadata).toBe('string');
    const parsed = JSON.parse(body[0]?.metadata ?? '{}') as { toolCalls: unknown[] };
    expect(Array.isArray(parsed.toolCalls)).toBe(true);
  });

  test('falls back to empty JSON object when metadata serialization fails', async () => {
    const circular: Record<string, unknown> = { self: null };
    circular.self = circular;

    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => [
      {
        id: 'msg-1',
        conversation_id: MOCK_CONV.id,
        role: 'assistant' as const,
        content: 'Response',
        // Simulate unserializable metadata from PostgreSQL JSONB
        metadata: circular as unknown as string,
        user_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ metadata: string }>;
    expect(body[0]?.metadata).toBe('{}');
  });

  test('returns 404 when conversation not found', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/unknown-conv/messages');
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('respects limit query parameter', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/conversations/web-test-abc/messages?limit=10');

    expect(mockListMessages).toHaveBeenCalledWith(MOCK_CONV.id, 10);
  });

  test('caps limit at 500', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/conversations/web-test-abc/messages?limit=9999');

    const [, passedLimit] = (mockListMessages.mock.calls[0] ?? []) as [unknown, number];
    expect(passedLimit).toBeLessThanOrEqual(500);
  });

  test('returns 500 when DB throws', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => {
      throw new Error('DB failure');
    });

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to list messages');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/conversations/:id/messages — tool output bounding (#2236)
// ---------------------------------------------------------------------------

describe('GET /api/conversations/:id/messages — tool output bounding', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockListMessages.mockReset();
  });

  test('truncates large tool output in hydration metadata without touching the DB value', async () => {
    const largeOutput = 'y'.repeat(MAX_TOOL_OUTPUT_CHARS + 10_000);
    const storedMetadata = JSON.stringify({
      toolCalls: [
        {
          name: 'bash',
          input: { command: 'cat file.txt' },
          output: largeOutput,
          duration: 500,
        },
      ],
    });

    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => [
      {
        id: 'msg-tool',
        conversation_id: MOCK_CONV.id,
        role: 'assistant' as const,
        content: '',
        metadata: storedMetadata,
        user_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ metadata: string }>;
    const returnedMeta = JSON.parse(body[0]!.metadata) as {
      toolCalls: Array<{ output: string }>;
    };

    // Returned tool output must be bounded, with the truncation marker appended
    expect(returnedMeta.toolCalls[0]!.output.length).toBeLessThan(largeOutput.length);
    expect(returnedMeta.toolCalls[0]!.output).toContain('[truncated');
    expect(returnedMeta.toolCalls[0]!.output).toContain('full output preserved on the server');
  });

  test('preserves tool output within the cap in hydration', async () => {
    const smallOutput = 'short output from tool';
    const metadata = JSON.stringify({
      toolCalls: [{ name: 'bash', input: {}, output: smallOutput, duration: 10 }],
    });

    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => [
      {
        id: 'msg-small',
        conversation_id: MOCK_CONV.id,
        role: 'assistant' as const,
        content: '',
        metadata,
        user_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    const body = (await response.json()) as Array<{ metadata: string }>;
    expect(body[0]!.metadata).toBe(metadata);
  });

  test('returns non-toolCall metadata (workflowResult etc.) unchanged', async () => {
    const metadata = JSON.stringify({ workflowResult: { runId: 'abc' } });

    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => [
      {
        id: 'msg-no-tools',
        conversation_id: MOCK_CONV.id,
        role: 'assistant' as const,
        content: 'Done.',
        metadata,
        user_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    const body = (await response.json()) as Array<{ metadata: string }>;
    expect(body[0]!.metadata).toBe(metadata);
  });
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/conversations/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/conversations/:id', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockUpdateConversationTitle.mockReset();
  });

  test('updates conversation title and returns success', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated Title' }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
    // Pinned: a rename through this route is a person choosing the name, and
    // the pin is what stops automatic re-titling from undoing it.
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      MOCK_CONV.id,
      'Updated Title',
      'person'
    );
  });

  test('truncates title to 255 characters', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const longTitle = 'x'.repeat(400);
    await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: longTitle }),
    });

    const lastCall = mockUpdateConversationTitle.mock.calls.at(-1) as [string, string];
    expect(lastCall[1].length).toBe(255);
  });

  test('returns success without updating title when body has no title field', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);

    const { app } = makeApp();
    const callsBefore = mockUpdateConversationTitle.mock.calls.length;
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ someOtherField: 'value' }),
    });
    expect(response.status).toBe(200);
    expect(mockUpdateConversationTitle.mock.calls.length).toBe(callsBefore);
  });

  test('returns 404 when conversation not found', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/unknown-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 for malformed JSON body', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json {{{',
    });
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tests: stop, queue, withdraw — against the REAL lock manager
// ---------------------------------------------------------------------------

/**
 * A handleMessage that records each message as it starts and stays in flight
 * until the test releases it, so ordering is asserted from the log and never
 * from a wall-clock margin.
 */
function gatedTurns(): {
  started: string[];
  signals: Map<string, AbortSignal>;
  release: (message: string) => void;
} {
  const started: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const gates = new Map<string, () => void>();
  mockHandleMessage.mockImplementation((async (
    _platform: unknown,
    _conversationId: string,
    message: string,
    context?: { abortSignal?: AbortSignal }
  ) => {
    started.push(message);
    if (context?.abortSignal) signals.set(message, context.abortSignal);
    await new Promise<void>(resolve => {
      gates.set(message, resolve);
      // A turn ends when its provider honours the abort — modelled directly.
      context?.abortSignal?.addEventListener('abort', () => {
        resolve();
      });
    });
  }) as unknown as () => Promise<void>);
  return {
    started,
    signals,
    release: message => {
      gates.get(message)?.();
    },
  };
}

/** Let the manager's promise chain hand off to the next turn. */
async function settle(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`never reached: ${what}`);
}

function makeRealApp(): { app: OpenAPIHono; manager: RealLockManager } {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const manager = new RealLockManager();
  registerApiRoutes(app, mockWebAdapter, manager as unknown as ConversationLockManager);
  return { app, manager };
}

async function send(
  app: OpenAPIHono,
  message: string
): Promise<{ accepted: boolean; status: string; queuedId?: string }> {
  const response = await app.request('/api/conversations/web-test-abc/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { accepted: boolean; status: string; queuedId?: string };
}

async function queueTexts(app: OpenAPIHono): Promise<string[]> {
  const response = await app.request('/api/conversations/web-test-abc/queue');
  expect(response.status).toBe(200);
  const body = (await response.json()) as { messages: { text: string }[] };
  return body.messages.map(m => m.text);
}

function persistedUserTexts(): string[] {
  return mockAddMessage.mock.calls.map(call => call[2]);
}

describe('message queue behind a running turn', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockFindConversationByPlatformId.mockImplementation(async () => MOCK_CONV);
    mockHandleMessage.mockReset();
    mockAddMessage.mockReset();
  });

  test('delivers queued messages in order, each exactly once, and lists them while waiting', async () => {
    const turns = gatedTurns();
    const { app, manager } = makeRealApp();

    expect((await send(app, 'first')).status).toBe('started');
    const second = await send(app, 'second');
    const third = await send(app, 'third');
    expect(second.status).toBe('queued-conversation');
    expect(third.status).toBe('queued-conversation');
    expect(second.queuedId).toBeString();

    // Waiting messages are visible, oldest first — and not yet in the history.
    expect(await queueTexts(app)).toEqual(['second', 'third']);
    await settle(() => turns.started.length === 1, 'first turn started');
    expect(persistedUserTexts()).toEqual(['first']);

    turns.release('first');
    await settle(() => turns.started.length === 2, 'second turn started');
    expect(await queueTexts(app)).toEqual(['third']);

    turns.release('second');
    await settle(() => turns.started.length === 3, 'third turn started');
    turns.release('third');
    await settle(() => manager.getStats().active === 0, 'idle');

    expect(turns.started).toEqual(['first', 'second', 'third']);
    expect(persistedUserTexts()).toEqual(['first', 'second', 'third']);
    expect(await queueTexts(app)).toEqual([]);
  });

  test('a message withdrawn before delivery is never delivered nor written to history', async () => {
    const turns = gatedTurns();
    const { app, manager } = makeRealApp();

    await send(app, 'first');
    const queued = await send(app, 'typo');

    const response = await app.request(
      `/api/conversations/web-test-abc/queue/${queued.queuedId ?? ''}`,
      { method: 'DELETE' }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'withdrawn', message: { text: 'typo' } });

    turns.release('first');
    await settle(() => manager.getStats().active === 0, 'idle');
    expect(turns.started).toEqual(['first']);
    expect(persistedUserTexts()).toEqual(['first']);
  });

  test('withdrawing a message that was already delivered changes nothing and says so', async () => {
    const turns = gatedTurns();
    const { app, manager } = makeRealApp();

    await send(app, 'first');
    const queued = await send(app, 'second');
    turns.release('first');
    await settle(() => turns.started.length === 2, 'second delivered');

    const response = await app.request(
      `/api/conversations/web-test-abc/queue/${queued.queuedId ?? ''}`,
      { method: 'DELETE' }
    );
    expect(await response.json()).toEqual({ status: 'not-queued' });

    turns.release('second');
    await settle(() => manager.getStats().active === 0, 'idle');
    // Delivered once, never withdrawn: one winner.
    expect(turns.started).toEqual(['first', 'second']);
  });
});

describe('POST /api/conversations/:id/interrupt', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockFindConversationByPlatformId.mockImplementation(async () => MOCK_CONV);
    mockHandleMessage.mockReset();
    mockAddMessage.mockReset();
  });

  test('aborts the running turn and releases the lock', async () => {
    const turns = gatedTurns();
    const { app } = makeRealApp();

    await send(app, 'long task');
    await settle(() => turns.signals.has('long task'), 'turn started with a signal');
    expect(turns.signals.get('long task')?.aborted).toBe(false);

    const response = await app.request('/api/conversations/web-test-abc/interrupt', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversationId: 'web-test-abc', status: 'stopped' });
    expect(turns.signals.get('long task')?.aborted).toBe(true);

    const lock = await app.request('/api/conversations/web-test-abc/lock');
    expect(await lock.json()).toEqual({ conversationId: 'web-test-abc', locked: false });
  });

  test('a queued message is delivered after the stopped turn, not aborted with it', async () => {
    const turns = gatedTurns();
    const { app } = makeRealApp();

    await send(app, 'first');
    await send(app, 'next');
    await app.request('/api/conversations/web-test-abc/interrupt', { method: 'POST' });
    await settle(() => turns.started.length === 2, 'queued message delivered');
    expect(turns.signals.get('next')?.aborted).toBe(false);
    turns.release('next');
  });

  test('says idle when nothing is running', async () => {
    const { app } = makeRealApp();
    const response = await app.request('/api/conversations/web-test-abc/interrupt', {
      method: 'POST',
    });
    expect(await response.json()).toEqual({ conversationId: 'web-test-abc', status: 'idle' });
  });

  test('404s for a conversation that does not exist', async () => {
    mockFindConversationByPlatformId.mockImplementation(async () => null);
    const { app } = makeRealApp();
    const response = await app.request('/api/conversations/nope/interrupt', { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
