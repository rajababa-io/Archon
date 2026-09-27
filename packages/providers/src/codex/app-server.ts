/**
 * A minimal client for `codex app-server`, the JSON-RPC surface of the Codex
 * CLI. Archon runs ordinary Codex turns through `@openai/codex-sdk` (`codex
 * exec`); this client exists for what only app-server exposes — listing skills
 * (`skills/list`) and Codex's own compact and review (`thread/compact/start`,
 * `review/start`).
 *
 * Both paths read and write the same rollout files under CODEX_HOME, so a
 * thread id from `codex exec` resumes here and a thread compacted here resumes
 * compacted in the next `codex exec` turn.
 *
 * Wire: one JSON object per line on stdin/stdout. The shapes below are the
 * narrow subset Archon reads, restated from the protocol `codex app-server
 * generate-ts` emits (codex-cli 0.151) because no published package carries
 * them. `app-server.test.ts` pins them against a fake server.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@archon/paths';
import type { MessageChunk, TokenUsage } from '../types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex.app-server');
  return cachedLog;
}

export interface CodexSkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  scope: 'user' | 'repo' | 'system' | 'admin';
  enabled: boolean;
}

interface SkillsListResponse {
  data: { cwd: string; skills: CodexSkillMetadata[]; errors: { message?: string }[] }[];
}

interface TurnError {
  message: string;
}

interface Turn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: TurnError | null;
}

type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'exitedReviewMode'; id: string; review: string }
  | { type: 'contextCompaction'; id: string }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | { type: string; id: string };

interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A client request waiting for its response. */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** How to start the app-server process. Injected so tests can run a fake server. */
export type SpawnAppServer = (env: Record<string, string>) => {
  stdin: { write(data: string): unknown; end(): unknown };
  stdout: AsyncIterable<Uint8Array>;
  kill(): void;
  exited: Promise<number>;
};

/**
 * The command that starts the Codex CLI. A pinned or compiled-binary install
 * resolves an executable path; an unpinned source install has none, and runs
 * the launcher script of the `@openai/codex` package the SDK itself depends on
 * — the same binary `codex exec` turns use.
 */
export function codexCliCommand(binaryPath: string | undefined): string[] {
  if (binaryPath !== undefined) return [binaryPath];
  const sdkRequire = createRequire(fileURLToPath(import.meta.resolve('@openai/codex-sdk')));
  return [process.execPath, sdkRequire.resolve('@openai/codex/bin/codex.js')];
}

export function spawnCodexAppServer(cliCommand: readonly string[]): SpawnAppServer {
  return env => {
    const proc = Bun.spawn([...cliCommand, 'app-server'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      env,
    });
    return {
      stdin: {
        write: (data: string): unknown => proc.stdin.write(data),
        end: (): unknown => proc.stdin.end(),
      },
      // Bun's ReadableStream is async-iterable; not every lib config this file
      // is type-checked under declares that.
      stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
      kill: (): void => {
        proc.kill();
      },
      exited: proc.exited,
    };
  };
}

export class CodexAppServerError extends Error {}

/** One app-server process for one operation. */
export class CodexAppServer {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private closedError: Error | undefined;

  private constructor(private readonly proc: ReturnType<SpawnAppServer>) {}

  static async open(spawn: SpawnAppServer, env: Record<string, string>): Promise<CodexAppServer> {
    const server = new CodexAppServer(spawn(env));
    void server.readLoop();
    await server.request('initialize', {
      clientInfo: { name: 'archon', title: 'Archon', version: '0' },
      capabilities: null,
    });
    server.notify('initialized');
    return server;
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of this.proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) this.dispatch(line);
        }
      }
      this.fail(new CodexAppServerError('codex app-server exited'));
    } catch (error) {
      this.fail(error as Error);
    }
  }

  private dispatch(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      getLog().warn({ line: line.slice(0, 200) }, 'codex.app_server_unparsable_line');
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      // A server-initiated request (an approval, a question). Archon starts
      // threads with approvals off, so this is unexpected — refuse it rather
      // than leave the turn waiting on an answer that never comes.
      getLog().warn({ method: message.method }, 'codex.app_server_unexpected_request');
      this.write({
        id: message.id,
        error: { code: -32601, message: 'Archon does not answer app-server requests' },
      });
      return;
    }
    if (message.method !== undefined) {
      for (const listener of this.listeners) listener(message.method, message.params ?? {});
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new CodexAppServerError(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: Error): void {
    this.closedError ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of this.listeners) listener('archon/closed', {});
  }

  private write(message: RpcMessage): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closedError !== undefined) return Promise.reject(this.closedError);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ id, method, params: params as Record<string, unknown> | undefined });
    });
  }

  notify(method: string): void {
    this.write({ method });
  }

  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }

  async listSkills(cwd: string): Promise<CodexSkillMetadata[]> {
    const response = await this.request<SkillsListResponse>('skills/list', { cwds: [cwd] });
    const entry = response.data.find(e => e.cwd === cwd) ?? response.data[0];
    if (entry === undefined) return [];
    for (const err of entry.errors) {
      getLog().warn({ cwd, error: err.message }, 'codex.skill_load_error');
    }
    return entry.skills;
  }
}

/** Thread settings a resumed or started thread runs with — the same posture `codex exec` turns use. */
export interface CodexThreadSettings {
  cwd: string;
  model?: string;
}

function threadParams(settings: CodexThreadSettings): Record<string, unknown> {
  return {
    cwd: settings.cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    ...(settings.model !== undefined ? { model: settings.model } : {}),
  };
}

/** What a Codex review looks at, from the command's free-text arguments. */
export function codexReviewTarget(args: string): Record<string, unknown> {
  const instructions = args.trim();
  return instructions.length > 0
    ? { type: 'custom', instructions }
    : { type: 'uncommittedChanges' };
}

/**
 * Run one app-server turn — compact or review — on a thread and stream it as
 * Archon message chunks, ending in one `result`.
 *
 * `threadId` undefined means the chat has no Codex session yet: compact has
 * nothing to act on, and review starts a fresh thread.
 */
export async function* runCodexAppServerTurn(
  server: CodexAppServer,
  action: 'compact' | 'review',
  args: string,
  threadId: string | undefined,
  settings: CodexThreadSettings,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  if (threadId === undefined && action === 'compact') {
    yield {
      type: 'assistant',
      content: 'Nothing to compact — this chat has no Codex session yet.',
    };
    yield { type: 'result' };
    return;
  }

  // Buffer notifications from the moment the listener is attached, so an event
  // that lands between the start request and the first read is not lost.
  const queue: { method: string; params: Record<string, unknown> }[] = [];
  let wake: (() => void) | undefined;
  const detach = server.onNotification((method, params) => {
    queue.push({ method, params });
    wake?.();
  });
  const onAbort = (): void => {
    queue.push({ method: 'archon/aborted', params: {} });
    wake?.();
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    let activeThreadId: string;
    if (threadId !== undefined) {
      await server.request('thread/resume', { threadId, ...threadParams(settings) });
      activeThreadId = threadId;
    } else {
      const started = await server.request<{ thread: { id: string } }>(
        'thread/start',
        threadParams(settings)
      );
      activeThreadId = started.thread.id;
    }

    let turnId: string | undefined;
    if (action === 'compact') {
      if (args.trim().length > 0) {
        yield {
          type: 'system',
          content: `⚠️ Codex compact takes no instructions; ignored: ${args.trim()}`,
        };
      }
      await server.request('thread/compact/start', { threadId: activeThreadId });
    } else {
      const started = await server.request<{ turn: Turn }>('review/start', {
        threadId: activeThreadId,
        target: codexReviewTarget(args),
        delivery: 'inline',
      });
      turnId = started.turn.id;
    }

    let usage: TokenUsage | undefined;
    for (;;) {
      const next = queue.shift();
      if (next === undefined) {
        await new Promise<void>(resolve => (wake = resolve));
        wake = undefined;
        continue;
      }
      const { method, params } = next;
      if (method === 'archon/aborted') throw new Error('Query aborted');
      if (method === 'archon/closed') {
        throw new CodexAppServerError('codex app-server exited before the turn completed');
      }
      if (params.threadId !== undefined && params.threadId !== activeThreadId) continue;
      if (method === 'turn/started' && turnId === undefined) {
        turnId = (params.turn as Turn | undefined)?.id;
        continue;
      }
      if (turnId !== undefined && params.turnId !== undefined && params.turnId !== turnId) continue;

      if (method === 'item/started') {
        const item = params.item as ThreadItem;
        if (item.type === 'commandExecution' && 'command' in item) {
          yield { type: 'tool', toolName: item.command, toolCallId: item.id };
        }
      } else if (method === 'item/completed') {
        const item = params.item as ThreadItem;
        if (item.type === 'agentMessage' && 'text' in item && item.text.length > 0) {
          yield { type: 'assistant', content: item.text };
        } else if (item.type === 'exitedReviewMode' && 'review' in item) {
          yield { type: 'assistant', content: item.review };
        } else if (item.type === 'contextCompaction') {
          yield { type: 'system', content: 'Context compacted.' };
        } else if (item.type === 'commandExecution' && 'command' in item) {
          yield {
            type: 'tool_result',
            toolName: item.command,
            toolOutput: item.aggregatedOutput ?? '',
            toolCallId: item.id,
            toolOutcome:
              item.exitCode === 0 ? 'success' : item.exitCode === null ? 'unknown' : 'error',
            ...(item.exitCode !== null ? { exitCode: item.exitCode } : {}),
          };
        }
      } else if (method === 'thread/tokenUsage/updated') {
        const last = (params.tokenUsage as { last?: TokenUsageBreakdown } | undefined)?.last;
        if (last !== undefined) {
          usage = {
            input: last.inputTokens,
            output: last.outputTokens,
            cacheRead: last.cachedInputTokens,
            cacheWrite: last.cacheWriteInputTokens,
            total: last.totalTokens,
          };
        }
      } else if (method === 'turn/completed') {
        const turn = params.turn as Turn;
        if (turn.status === 'failed') {
          yield {
            type: 'result',
            sessionId: activeThreadId,
            isError: true,
            errorSubtype: 'codex_turn_failed',
            errors: [turn.error?.message ?? 'Codex turn failed'],
          };
        } else {
          yield { type: 'result', sessionId: activeThreadId, ...(usage ? { tokens: usage } : {}) };
        }
        return;
      }
    }
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    detach();
  }
}
