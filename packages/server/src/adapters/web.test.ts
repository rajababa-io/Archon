import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock logger before importing any module that transitively imports @archon/paths
const mockLogger = {
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
  level: 'info' as const,
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Records every durable-write call in order, so the test can assert that the
// buffer was flushed BEFORE the notice was written rather than merely that both
// happened. Declared before the import of ./web so the module mock is in place.
const dbCalls: string[] = [];
const usageWrites: unknown[][] = [];
mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async (conversationId: string, role: string, content: string) => {
    dbCalls.push(`addMessage:${role}:${content}`);
    return { id: 'm1', conversation_id: conversationId, role, content };
  }),
  attachUsageToLatestAssistantMessage: mock(async (...args: unknown[]) => {
    usageWrites.push(args);
  }),
}));

import { WebAdapter } from './web';
import { MAX_TOOL_OUTPUT_CHARS } from './web/truncate';
import { DASHBOARD_STREAM, type SSETransport } from './web/transport';
import type { MessagePersistence } from './web/persistence';
import type { WorkflowEventBridge } from './web/workflow-bridge';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(options?: { dashboardConnected?: boolean; seam?: string }): {
  adapter: WebAdapter;
  emitted: string[];
  dashboard: string[];
  appendToolResultCalls: unknown[][];
} {
  const emitted: string[] = [];
  const dashboard: string[] = [];
  const appendToolResultCalls: unknown[][] = [];

  const mockTransport = {
    emit: mock(async (_id: string, event: string) => {
      emitted.push(event);
    }),
    hasActiveStream: mock((id: string) =>
      id === DASHBOARD_STREAM ? (options?.dashboardConnected ?? true) : true
    ),
    emitWorkflowEvent: mock((id: string, event: string) => {
      if (id === DASHBOARD_STREAM) dashboard.push(event);
    }),
  } as unknown as SSETransport;

  const mockPersistence = {
    appendToolResult: mock((_id: string, name: string, output: string, duration: number) => {
      appendToolResultCalls.push([_id, name, output, duration]);
    }),
    appendToolCall: mock(() => {}),
    appendText: mock(() => options?.seam ?? ''),
    flush: mock(async () => {
      dbCalls.push('flush');
    }),
    conversationDbId: mock(() => 'conv-db-1'),
    finalizeRunningTools: mock(() => {}),
  } as unknown as MessagePersistence;

  const mockBridge = {
    emitOutput: mock(() => {}),
    registerOutputCallback: mock(() => {}),
    removeOutputCallback: mock(() => {}),
    setStepTransitionCallback: mock(() => {}),
    start: mock(() => {}),
    stop: mock(() => {}),
    bridgeWorkerEvents: mock(() => () => {}),
  } as unknown as WorkflowEventBridge;

  const adapter = new WebAdapter(mockTransport, mockPersistence, mockBridge);
  return { adapter, emitted, dashboard, appendToolResultCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
});

describe('WebAdapter.sendStructuredEvent — tool_result output bounding', () => {
  test('truncates SSE event output when toolOutput exceeds the cap', async () => {
    const { adapter, emitted } = makeAdapter();
    const largeOutput = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 50_000);

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_result',
      toolName: 'bash',
      toolOutput: largeOutput,
    });

    expect(emitted.length).toBe(1);
    const parsed = JSON.parse(emitted[0]!) as { output: string };
    expect(parsed.output.length).toBeLessThan(largeOutput.length);
    expect(parsed.output).toContain('[truncated');
    expect(parsed.output).toContain('full output preserved on the server');
  });

  test('passes SSE event output through unchanged when within the cap', async () => {
    const { adapter, emitted } = makeAdapter();
    const smallOutput = 'small tool output';

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_result',
      toolName: 'bash',
      toolOutput: smallOutput,
    });

    expect(emitted.length).toBe(1);
    const parsed = JSON.parse(emitted[0]!) as { output: string };
    expect(parsed.output).toBe(smallOutput);
  });

  test('persists full untruncated output to DB regardless of the SSE cap', async () => {
    const { adapter, appendToolResultCalls } = makeAdapter();
    const largeOutput = 'z'.repeat(MAX_TOOL_OUTPUT_CHARS + 50_000);

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_result',
      toolName: 'bash',
      toolOutput: largeOutput,
    });

    expect(appendToolResultCalls.length).toBe(1);
    // Third argument to appendToolResult is the output — must be the full string
    expect(appendToolResultCalls[0]![2]).toBe(largeOutput);
  });
});

describe('WebAdapter.sendMessage — text event category', () => {
  test('carries the metadata category on the text event', async () => {
    const { adapter, emitted } = makeAdapter();

    await adapter.sendMessage('conv-1', '🚀 Dispatching workflow: **plan**', {
      category: 'workflow_dispatch_status',
      segment: 'new',
    });

    expect(emitted.length).toBe(1);
    const parsed = JSON.parse(emitted[0]!) as { type: string; category?: string };
    expect(parsed.type).toBe('text');
    expect(parsed.category).toBe('workflow_dispatch_status');
  });

  test('omits the category key entirely for agent prose', async () => {
    const { adapter, emitted } = makeAdapter();

    await adapter.sendMessage('conv-1', 'ordinary assistant text');

    expect(emitted.length).toBe(1);
    const parsed = JSON.parse(emitted[0]!) as Record<string, unknown>;
    expect('category' in parsed).toBe(false);
  });

  test('still suppresses structurally-handled categories rather than emitting them', async () => {
    const { adapter, emitted } = makeAdapter();

    await adapter.sendMessage('conv-1', 'formatted tool call', {
      category: 'tool_call_formatted',
    });
    await adapter.sendMessage('conv-1', '📍 repo @ `branch`', {
      category: 'isolation_context',
    });

    expect(emitted.length).toBe(0);
  });

  test('streams the seam the buffer placed, so the live view matches the saved row', async () => {
    const { adapter, emitted } = makeAdapter({ seam: '\n\n' });

    await adapter.sendMessage('conv-1', 'Issue #96 — all green.');

    const parsed = JSON.parse(emitted[0]!) as { content: string };
    expect(parsed.content).toBe('\n\nIssue #96 — all green.');
  });
});

describe('WebAdapter.emitLockEvent — dashboard mirror', () => {
  test('a chat starting and stopping work is announced on the dashboard feed', async () => {
    const { adapter, dashboard } = makeAdapter();

    await adapter.emitLockEvent('conv-1', true);
    await adapter.emitLockEvent('conv-1', false);

    // Without this, a console looking at a DIFFERENT chat learns that this one
    // is working only when its /api/health poll next comes round.
    expect(dashboard.map(e => JSON.parse(e) as { type: string; locked: boolean })).toEqual([
      {
        type: 'conversation_lock',
        conversationId: 'conv-1',
        locked: true,
        timestamp: expect.any(Number),
      },
      {
        type: 'conversation_lock',
        conversationId: 'conv-1',
        locked: false,
        timestamp: expect.any(Number),
      },
    ] as unknown as { type: string; locked: boolean }[]);
  });

  test('nothing is buffered for a dashboard nobody is watching', async () => {
    const { adapter, dashboard, emitted } = makeAdapter({ dashboardConnected: false });

    await adapter.emitLockEvent('conv-1', true);

    expect(dashboard).toEqual([]);
    // The conversation's own stream still gets it — that one buffers on purpose.
    expect(emitted.some(e => e.includes('conversation_lock'))).toBe(true);
  });
});

describe('WebAdapter.sendStructuredEvent — activity on the dashboard feed', () => {
  test('a tool starting is announced, carrying what it is', async () => {
    const { adapter, dashboard } = makeAdapter();

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool',
      toolName: 'Edit',
      toolCallId: 't1',
      toolInput: { file_path: 'rail.css' },
    });

    // Carries its payload rather than triggering a refetch: at one event per
    // tool call, a refetch each would be the busiest request the console makes
    // — to be told what the event already said.
    expect(dashboard.map(e => JSON.parse(e) as unknown)).toEqual([
      {
        type: 'conversation_activity',
        conversationId: 'conv-1',
        name: 'Edit',
        input: { file_path: 'rail.css' },
        startedAt: expect.any(Number),
      },
    ]);
  });

  test('the input it carries is bounded, not the whole tool payload', async () => {
    const { adapter, dashboard } = makeAdapter();

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool',
      toolName: 'Bash',
      toolCallId: 't1',
      toolInput: { command: 'x'.repeat(5_000) },
    });

    const { input } = JSON.parse(dashboard[0]!) as { input: Record<string, string> };
    expect(input.command!.length).toBeLessThan(5_000);
  });

  test('a tool finishing announces nothing — the gap between tools is not idleness', async () => {
    const { adapter, dashboard } = makeAdapter();

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool',
      toolName: 'Read',
      toolCallId: 't1',
      toolInput: { file_path: 'a.ts' },
    });
    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_result',
      toolName: 'Read',
      toolCallId: 't1',
      toolOutput: 'ok',
    });

    // currentActivity still answers 'Read' here (see below), so an event
    // clearing it would put the pushed state and the polled state in
    // disagreement — and the next snapshot would flick the name back on.
    expect(dashboard.length).toBe(1);
  });

  test('nothing is buffered for a dashboard nobody is watching', async () => {
    const { adapter, dashboard, emitted } = makeAdapter({ dashboardConnected: false });

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool',
      toolName: 'Read',
      toolCallId: 't1',
      toolInput: {},
    });

    expect(dashboard).toEqual([]);
    // The conversation's own stream still gets its tool_call — that one
    // buffers on purpose, so a reconnecting tab does not lose the card.
    expect(emitted.some(e => e.includes('tool_call'))).toBe(true);
  });
});

describe('WebAdapter.currentActivity — what each chat is doing', () => {
  test('a finished tool still answers, because the gap between tools is not idleness', async () => {
    const { adapter } = makeAdapter();

    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool',
      toolName: 'Bash',
      toolCallId: 't1',
      toolInput: { command: 'bun run lint' },
    });
    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_result',
      toolName: 'Bash',
      toolCallId: 't1',
      toolOutput: 'ok',
    });

    // Without this the rail showed the fallback word almost always: most tools
    // finish well inside the interval anything polls at.
    const activity = adapter.currentActivity().get('conv-1');
    expect(activity?.name).toBe('Bash');
    expect(activity?.input.command).toBe('bun run lint');
  });

  test('a tool in flight outranks the one before it', async () => {
    const { adapter } = makeAdapter();
    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool',
      toolName: 'Read',
      toolCallId: 't1',
      toolInput: { file_path: 'a.ts' },
    });
    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool_result',
      toolName: 'Read',
      toolCallId: 't1',
      toolOutput: '',
    });
    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool',
      toolName: 'Grep',
      toolCallId: 't2',
      toolInput: { pattern: 'actionType' },
    });

    expect(adapter.currentActivity().get('conv-1')?.name).toBe('Grep');
  });

  test('the turn ending clears it, so a finished chat describes nothing', async () => {
    const { adapter } = makeAdapter();
    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool',
      toolName: 'Bash',
      toolCallId: 't1',
      toolInput: { command: 'ls' },
    });
    await adapter.emitLockEvent('conv-1', false);

    expect(adapter.currentActivity().has('conv-1')).toBe(false);
  });

  test('a huge input is bounded before it rides a polled health check', async () => {
    const { adapter } = makeAdapter();
    await adapter.sendStructuredEvent('conv-1', {
      type: 'tool',
      toolName: 'Write',
      toolCallId: 't1',
      toolInput: { file_path: 'a.ts', content: 'x'.repeat(50_000), lines: 400 },
    });

    const input = adapter.currentActivity().get('conv-1')?.input ?? {};
    expect(input.content?.length).toBe(160);
    expect(input.lines).toBeUndefined(); // non-strings are dropped, not stringified
  });
});

describe('WebAdapter.sendDurableNotice', () => {
  test('flushes the reply BEFORE writing the notice, so it lands after it', async () => {
    dbCalls.length = 0;
    const { adapter } = makeAdapter();

    await adapter.sendDurableNotice('conv-1', 'Handing off automatically — 55%.');

    // Order is the whole point: written without flushing first, the notice
    // races the reply it explains and renders above it.
    expect(dbCalls).toEqual(['flush', 'addMessage:system:Handing off automatically — 55%.']);
  });

  test('also sends it live, so a watching console sees it immediately', async () => {
    const { adapter, emitted } = makeAdapter();

    await adapter.sendDurableNotice('conv-1', 'Worth wrapping up soon.');

    const frames = emitted.map(e => JSON.parse(e) as { type: string; content?: string });
    const notice = frames.find(f => f.type === 'system_status');
    expect(notice?.content).toBe('Worth wrapping up soon.');
  });
});

describe('WebAdapter.sendResultFooter', () => {
  beforeEach(() => {
    usageWrites.length = 0;
  });

  test('persists the effort the turn ran with alongside its usage', async () => {
    const { adapter } = makeAdapter();
    await adapter.sendResultFooter('conv-1', {
      tokens: { input: 100, output: 20 },
      model: 'gpt-5.5',
      effort: 'medium',
    });
    expect(usageWrites).toHaveLength(1);
    expect(usageWrites[0]?.[1]).toMatchObject({ model: 'gpt-5.5', effort: 'medium' });
  });

  test('an effort left to the provider default writes no effort key', async () => {
    const { adapter } = makeAdapter();
    await adapter.sendResultFooter('conv-1', { tokens: { input: 100, output: 20 } });
    expect(usageWrites[0]?.[1]).not.toHaveProperty('effort');
    expect(usageWrites[0]?.[1]).not.toHaveProperty('costUsd');
  });
});
