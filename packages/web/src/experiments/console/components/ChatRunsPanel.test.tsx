import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { Run } from '../primitives/run';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { ChatRunsPanel } from './ChatRunsPanel';

const CHAT_DB_ID = 'chat-conv-db-id';

const baseRun: Omit<Run, 'id' | 'status' | 'workflow'> = {
  projectId: 'project-1',
  projectName: 'Archon',
  costUsd: null,
  // The per-run WORKER conversation, deliberately NOT the chat: the two are
  // different rows for every chat-launched run, and the panel joins on the chat.
  conversationId: 'worker-conv-db-id',
  parentConversationId: CHAT_DB_ID,
  conversationPlatformId: null,
  workerPlatformId: null,
  parentPlatformId: null,
  origin: 'web',
  outcome: null,
  startedAt: '2026-09-01T10:00:00.000Z',
  finishedAt: null,
  lastActivityAt: null,
  workingPath: null,
  userMessage: 'Take issue 24 through to a PR',
  activeNodes: [],
  currentNode: null,
  lastTool: null,
};

function render(runs: Run[]): string {
  const cacheKey = K.chatRuns(CHAT_DB_ID);
  set(cacheKey, {
    runs,
    counts: {
      all: runs.length,
      running: 0,
      paused: 0,
      failed: 0,
      completed: 0,
      cancelled: 0,
      pending: 0,
    },
    total: runs.length,
  });
  try {
    return renderToStaticMarkup(
      <MemoryRouter>
        <ChatRunsPanel conversationDbId={CHAT_DB_ID} projectId="project-1" />
      </MemoryRouter>
    );
  } finally {
    invalidate(cacheKey);
  }
}

/** How many times `needle` occurs in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('ChatRunsPanel', () => {
  test('lists in-progress and finished runs alike, each linking to its run detail', () => {
    const html = render([
      { ...baseRun, id: 'run-live', workflow: 'implement', status: 'running' },
      {
        ...baseRun,
        id: 'run-done',
        workflow: 'review',
        status: 'completed',
        finishedAt: '2026-09-01T10:30:00.000Z',
      },
    ]);

    expect(html).toContain('From this chat');
    expect(html).toContain('Running');
    expect(html).toContain('Completed');
    expect(html).toContain('/console/p/project-1/r/run-live');
    expect(html).toContain('/console/p/project-1/r/run-done');
  });

  test('an in-flight run from this chat renders exactly once', () => {
    // The whole point of retiring WorkflowDock: one strip, one row per run.
    // Two adjacent chat-scoped panels drew every live run twice.
    const html = render([{ ...baseRun, id: 'run-live', workflow: 'implement', status: 'running' }]);

    expect(count(html, '/console/p/project-1/r/run-live')).toBe(1);
    expect(count(html, 'implement')).toBe(1);
  });

  test('a chat that has launched nothing renders no strip at all', () => {
    // Not an empty state — an empty state above the composer is permanent
    // furniture answering a question nobody asked.
    expect(render([])).toBe('');
  });

  test('truncates past five rows behind a "Show all" affordance', () => {
    const runs = Array.from({ length: 7 }, (_, i) => ({
      ...baseRun,
      id: `run-${i.toString()}`,
      workflow: 'implement',
      status: 'completed' as const,
    }));

    const html = render(runs);

    expect(html).toContain('/console/p/project-1/r/run-4');
    expect(html).not.toContain('/console/p/project-1/r/run-5');
    expect(html).toContain('Show all 7');
  });

  test('renders every active node for a parallel run', () => {
    const html = render([
      {
        ...baseRun,
        id: 'run-parallel',
        workflow: 'implement',
        status: 'running',
        activeNodes: ['parallel-a', 'parallel-b'],
      },
    ]);

    expect(html).toContain('nodes:');
    expect(html).toContain('parallel-a, parallel-b');
  });
});

describe('ChatRunsPanel — a gate stays answerable without leaving the chat', () => {
  const gated: Run = {
    ...baseRun,
    id: 'run-gated',
    workflow: 'deliver',
    status: 'paused',
    approval: {
      nodeId: 'approve-plan',
      message: 'Plan ready — ship it?',
      completionSignaled: false,
      decisions: [{ id: 'approve' }, { id: 'reject' }],
      decisionsAuthored: false,
    },
  };

  test('a paused run holding a gate renders its approval inline', () => {
    const html = render([gated]);

    expect(html).toContain('Waiting for approval');
    expect(html).toContain('Plan ready — ship it?');
    // The inline decision controls, not just a link out to the run page.
    expect(html).toContain('optional comment to send with approval');
  });

  test('the approval survives truncation — it is never hidden behind "Show all"', () => {
    // Six finished runs would push a seventh row out of the collapsed list. An
    // approval needs the human, so it is not part of that list at all.
    const finished = Array.from({ length: 6 }, (_, i) => ({
      ...baseRun,
      id: `run-old-${i.toString()}`,
      workflow: 'review',
      status: 'completed' as const,
    }));

    const html = render([gated, ...finished]);

    expect(html).toContain('Waiting for approval');
    expect(html).toContain('Show all 6');
  });

  test('a paused run with no gate is a row, not an approval card', () => {
    // A durable wait (timer, event) is paused without asking anything of you.
    const html = render([{ ...baseRun, id: 'run-waiting', workflow: 'deliver', status: 'paused' }]);

    expect(html).not.toContain('optional comment to send with approval');
    expect(html).toContain('/console/p/project-1/r/run-waiting');
  });
});
