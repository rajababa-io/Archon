import { describe, expect, test } from 'bun:test';
import type { MessageChunk } from '../types';
import {
  CodexAppServer,
  codexReviewTarget,
  runCodexAppServerTurn,
  type SpawnAppServer,
} from './app-server';

type Handler = (
  method: string,
  params: Record<string, unknown>,
  emit: (message: Record<string, unknown>) => void
) => unknown;

/**
 * A stand-in for `codex app-server`: answers requests with `handler` and lets
 * it push notifications. Records every message the client wrote.
 */
function fakeServer(handler: Handler): {
  spawn: SpawnAppServer;
  written: Record<string, unknown>[];
  exit: () => void;
} {
  const written: Record<string, unknown>[] = [];
  const encoder = new TextEncoder();
  let push: ((line: Uint8Array | null) => void) | undefined;
  const pending: (Uint8Array | null)[] = [];
  const emit = (message: Record<string, unknown>): void => {
    const line = encoder.encode(`${JSON.stringify(message)}\n`);
    if (push) push(line);
    else pending.push(line);
  };
  const stdout: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next =
          pending.length > 0
            ? pending.shift()
            : await new Promise<Uint8Array | null>(resolve => {
                push = line => {
                  push = undefined;
                  resolve(line);
                };
              });
        if (next === undefined) continue;
        if (next === null) return;
        yield next;
      }
    },
  };
  const exit = (): void => {
    if (push) push(null);
    else pending.push(null);
  };
  const spawn: SpawnAppServer = () => ({
    stdin: {
      write(data: string): void {
        for (const line of data.split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as Record<string, unknown>;
          written.push(message);
          if (typeof message.id === 'number' && typeof message.method === 'string') {
            const result = handler(
              message.method,
              (message.params ?? {}) as Record<string, unknown>,
              emit
            );
            if (result instanceof Error) {
              emit({ id: message.id, error: { code: -1, message: result.message } });
            } else {
              emit({ id: message.id, result: result ?? {} });
            }
          }
        }
      },
      end: (): void => undefined,
    },
    stdout,
    kill: exit,
    exited: Promise.resolve(0),
  });
  return { spawn, written, exit };
}

async function collect(stream: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('CodexAppServer', () => {
  test('initializes, then lists the skills for the asked directory', async () => {
    const fake = fakeServer((method, params) => {
      if (method === 'skills/list') {
        expect(params).toEqual({ cwds: ['/repo'] });
        return {
          data: [
            {
              cwd: '/repo',
              skills: [{ name: 'imagegen', description: 'd', scope: 'system', enabled: true }],
              errors: [],
            },
          ],
        };
      }
      return {};
    });
    const server = await CodexAppServer.open(fake.spawn, {});
    const skills = await server.listSkills('/repo');
    expect(skills.map(s => s.name)).toEqual(['imagegen']);
    expect(fake.written.map(m => m.method)).toEqual(['initialize', 'initialized', 'skills/list']);
    server.close();
  });

  test('refuses a request the server makes of the client', async () => {
    const fake = fakeServer((method, _params, emit) => {
      if (method === 'skills/list') {
        emit({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: {} });
        return { data: [] };
      }
      return {};
    });
    const server = await CodexAppServer.open(fake.spawn, {});
    await server.listSkills('/repo');
    expect(fake.written).toContainEqual(
      expect.objectContaining({ id: 'srv-1', error: expect.anything() })
    );
    server.close();
  });
});

describe('runCodexAppServerTurn', () => {
  test('compact resumes the chat thread, compacts it, and ends in one result', async () => {
    const fake = fakeServer((method, params, emit) => {
      if (method === 'thread/compact/start') {
        const at = { threadId: params.threadId, turnId: 't1' };
        emit({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: 't1' } } });
        emit({
          method: 'item/completed',
          params: { ...at, item: { type: 'contextCompaction', id: 'i1' } },
        });
        emit({
          method: 'turn/completed',
          params: { ...at, turn: { id: 't1', status: 'completed', error: null } },
        });
      }
      return {};
    });
    const server = await CodexAppServer.open(fake.spawn, {});
    const chunks = await collect(
      runCodexAppServerTurn(server, 'compact', '', 'thread-9', { cwd: '/repo', model: 'm' })
    );
    expect(chunks).toEqual([
      { type: 'system', content: 'Context compacted.' },
      { type: 'result', sessionId: 'thread-9' },
    ]);
    const resume = fake.written.find(m => m.method === 'thread/resume');
    expect(resume?.params).toEqual({
      threadId: 'thread-9',
      cwd: '/repo',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      model: 'm',
    });
    server.close();
  });

  test('compact without a session says there is nothing to compact', async () => {
    const fake = fakeServer(() => ({}));
    const server = await CodexAppServer.open(fake.spawn, {});
    const chunks = await collect(
      runCodexAppServerTurn(server, 'compact', '', undefined, { cwd: '/repo' })
    );
    expect(chunks.at(-1)).toEqual({ type: 'result' });
    expect(fake.written.some(m => m.method === 'thread/compact/start')).toBe(false);
    server.close();
  });

  test('review starts a thread when there is none and streams the review text', async () => {
    const fake = fakeServer((method, params, emit) => {
      if (method === 'thread/start') return { thread: { id: 'new-thread' } };
      if (method === 'review/start') {
        expect(params.target).toEqual({ type: 'custom', instructions: 'check auth' });
        const at = { threadId: 'new-thread', turnId: 'r1' };
        queueMicrotask(() => {
          emit({
            method: 'item/started',
            params: { ...at, item: { type: 'commandExecution', id: 'c1', command: 'git diff' } },
          });
          emit({
            method: 'item/completed',
            params: {
              ...at,
              item: {
                type: 'commandExecution',
                id: 'c1',
                command: 'git diff',
                aggregatedOutput: 'x',
                exitCode: 0,
              },
            },
          });
          emit({
            method: 'item/completed',
            params: { ...at, item: { type: 'exitedReviewMode', id: 'e1', review: 'No findings.' } },
          });
          emit({
            method: 'turn/completed',
            params: { ...at, turn: { id: 'r1', status: 'completed', error: null } },
          });
        });
        return {
          turn: { id: 'r1', status: 'inProgress', error: null },
          reviewThreadId: 'new-thread',
        };
      }
      return {};
    });
    const server = await CodexAppServer.open(fake.spawn, {});
    const chunks = await collect(
      runCodexAppServerTurn(server, 'review', 'check auth', undefined, { cwd: '/repo' })
    );
    expect(chunks.map(c => c.type)).toEqual(['tool', 'tool_result', 'assistant', 'result']);
    expect(chunks[2]).toEqual({ type: 'assistant', content: 'No findings.' });
    expect(chunks[3]).toEqual({ type: 'result', sessionId: 'new-thread' });
    server.close();
  });

  test('a failed turn is an error result carrying Codex’s message', async () => {
    const fake = fakeServer((method, params, emit) => {
      if (method === 'thread/compact/start') {
        emit({
          method: 'turn/completed',
          params: {
            threadId: params.threadId,
            turnId: 't1',
            turn: { id: 't1', status: 'failed', error: { message: '401 Unauthorized' } },
          },
        });
      }
      return {};
    });
    const server = await CodexAppServer.open(fake.spawn, {});
    const chunks = await collect(
      runCodexAppServerTurn(server, 'compact', '', 'thread-9', { cwd: '/repo' })
    );
    expect(chunks).toEqual([
      {
        type: 'result',
        sessionId: 'thread-9',
        isError: true,
        errorSubtype: 'codex_turn_failed',
        errors: ['401 Unauthorized'],
      },
    ]);
    server.close();
  });

  test('a server that exits mid-turn fails the turn instead of hanging it', async () => {
    const fake = fakeServer((method, _params) => {
      if (method === 'thread/compact/start') queueMicrotask(() => fake.exit());
      return {};
    });
    const server = await CodexAppServer.open(fake.spawn, {});
    await expect(
      collect(runCodexAppServerTurn(server, 'compact', '', 'thread-9', { cwd: '/repo' }))
    ).rejects.toThrow('exited before the turn completed');
  });

  test('a thread the server does not know is a thrown error', async () => {
    const fake = fakeServer(method =>
      method === 'thread/resume' ? new Error('no rollout found for thread id x') : {}
    );
    const server = await CodexAppServer.open(fake.spawn, {});
    await expect(
      collect(runCodexAppServerTurn(server, 'compact', '', 'x', { cwd: '/repo' }))
    ).rejects.toThrow('no rollout found');
    server.close();
  });
});

test('review with no instructions reviews the uncommitted changes', () => {
  expect(codexReviewTarget('  ')).toEqual({ type: 'uncommittedChanges' });
  expect(codexReviewTarget('look at auth')).toEqual({
    type: 'custom',
    instructions: 'look at auth',
  });
});
