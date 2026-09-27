/**
 * A signed `check_run` delivery, through the real adapter, the real CI-watch
 * service and a real SQLite database, to the one message a watching chat gets.
 *
 * GitHub itself is the only stub: the adapter's Octokit answers the check-run
 * and check-suite listings from a table this test controls, so "partial" and
 * "complete" are decided by the same `summarizeHeadChecks` production uses.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalArchonDocker = process.env.ARCHON_DOCKER;
const originalWorkspacePath = process.env.WORKSPACE_PATH;
const archonHome = await mkdtemp(join(tmpdir(), 'archon-github-ci-watch-'));
process.env.ARCHON_HOME = archonHome;
delete process.env.DATABASE_URL;
// Cleared for the reason workflow-signal.integration.test.ts gives: inside a
// container getArchonHome() ignores ARCHON_HOME and would reach the operator's
// real database.
delete process.env.ARCHON_DOCKER;
delete process.env.WORKSPACE_PATH;

const { GitHubAdapter } = await import('./adapter');
const { closeDatabase, getDatabase } = await import('@archon/core/db');
const { openCiWatch } = await import('@archon/core/db/ci-watches');
const { settleCiWatchesForHead } = await import('@archon/core/services/ci-watch');
type CiWatchDeps = import('@archon/core/services/ci-watch').CiWatchDeps;

afterAll(async () => {
  await closeDatabase();
  await removeTempTree(archonHome);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalArchonDocker === undefined) delete process.env.ARCHON_DOCKER;
  else process.env.ARCHON_DOCKER = originalArchonDocker;
  if (originalWorkspacePath === undefined) delete process.env.WORKSPACE_PATH;
  else process.env.WORKSPACE_PATH = originalWorkspacePath;
});

const SECRET = 'ci-watch-webhook-secret';
const SHA = 'e'.repeat(40);
const UNWATCHED_SHA = 'f'.repeat(40);

interface Run {
  name: string;
  status: string;
  conclusion: string | null;
}

/** GitHub's state for the watched commit, as the stubbed listings report it. */
let runs: Run[] = [];
let suiteStatus = 'completed';
let forgeReads = 0;
const sent: { conversationId: string; message: string }[] = [];

function signed(body: object): { payload: string; signature: string } {
  const payload = JSON.stringify(body);
  return {
    payload,
    signature: `sha256=${createHmac('sha256', SECRET).update(payload).digest('hex')}`,
  };
}

function checkRunCompleted(headSha: string): object {
  return {
    action: 'completed',
    check_run: {
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      completed_at: new Date().toISOString(),
      pull_requests: [{ number: 9 }],
    },
    repository: { full_name: 'Example/Repo' },
    sender: { login: 'github-actions[bot]' },
  };
}

function makeAdapter(): InstanceType<typeof GitHubAdapter> {
  const adapter = new GitHubAdapter({ kind: 'pat', token: 'unused-test-token' }, SECRET, {
    acquireLock: async (_id: string, handler: () => Promise<void>) => {
      await handler();
      return { status: 'started' as const };
    },
  });
  const unused = (): Promise<never> => Promise.reject(new Error('not part of a check_run'));
  // @ts-expect-error - GitHub is the only stub; everything else is real
  adapter.octokit = {
    rest: {
      issues: { createComment: unused, listComments: unused },
      repos: { get: unused },
      pulls: { get: unused },
      checks: {
        listForRef: async () => {
          forgeReads += 1;
          return { data: { total_count: runs.length, check_runs: runs } };
        },
        listSuitesForRef: async () => ({
          data: {
            total_count: 1,
            check_suites: [{ status: suiteStatus, latest_check_runs_count: runs.length }],
          },
        }),
      },
    },
  };
  const deps: CiWatchDeps = {
    readHeadChecks: (repo, headSha) => adapter.readHeadChecks(repo, headSha),
    deliver: async (watch, message) => {
      sent.push({ conversationId: watch.conversationId, message });
      return 'delivered';
    },
  };
  adapter.onCheckRunCompleted(async (repo, headSha) => {
    await settleCiWatchesForHead(repo, headSha, deps);
  });
  return adapter;
}

let chatCounter = 0;
async function watchingChat(): Promise<string> {
  chatCounter += 1;
  const id = `ci-watch-chat-${String(chatCounter)}`;
  await getDatabase().query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ($1, 'web', $2)`,
    [id, `web-${id}`]
  );
  await openCiWatch({ conversationId: id, repo: 'example/repo', headSha: SHA, pullRequest: 9 });
  return id;
}

beforeEach(async () => {
  await getDatabase().query('DELETE FROM remote_agent_ci_watches', []);
  runs = [];
  suiteStatus = 'completed';
  forgeReads = 0;
  sent.length = 0;
});

describe('check_run webhook → CI watch', () => {
  test('all checks on the watched commit done: one message, to the owning chat', async () => {
    const chat = await watchingChat();
    runs = [
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'completed', conclusion: 'success' },
    ];
    const { payload, signature } = signed(checkRunCompleted(SHA));

    const result = await makeAdapter().receiveWebhook(
      payload,
      signature,
      'delivery-1',
      'check_run'
    );

    expect(result).toBe('accepted');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.conversationId).toBe(chat);
    expect(sent[0]?.message).toContain('all 2 checks passed');
  });

  test('one job done while another runs: nothing is sent', async () => {
    await watchingChat();
    runs = [
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'in_progress', conclusion: null },
    ];
    suiteStatus = 'in_progress';
    const { payload, signature } = signed(checkRunCompleted(SHA));

    await makeAdapter().receiveWebhook(payload, signature, 'delivery-2', 'check_run');

    expect(sent).toEqual([]);
  });

  test('a commit nobody watches: nothing is sent and GitHub is not asked', async () => {
    await watchingChat();
    runs = [{ name: 'lint', status: 'completed', conclusion: 'success' }];
    const { payload, signature } = signed(checkRunCompleted(UNWATCHED_SHA));

    await makeAdapter().receiveWebhook(payload, signature, 'delivery-3', 'check_run');

    expect(sent).toEqual([]);
    expect(forgeReads).toBe(0);
  });

  test('a replayed delivery sends nothing more', async () => {
    await watchingChat();
    runs = [{ name: 'lint', status: 'completed', conclusion: 'success' }];
    const { payload, signature } = signed(checkRunCompleted(SHA));
    const adapter = makeAdapter();

    await adapter.receiveWebhook(payload, signature, 'delivery-4', 'check_run');
    await adapter.receiveWebhook(payload, signature, 'delivery-4', 'check_run');

    expect(sent).toHaveLength(1);
    // Dropped at the delivery id, before GitHub is asked a second time.
    expect(forgeReads).toBe(1);
  });

  test('a wrongly signed body is rejected before any lookup', async () => {
    await watchingChat();
    runs = [{ name: 'lint', status: 'completed', conclusion: 'success' }];
    const { payload } = signed(checkRunCompleted(SHA));
    const forged = `sha256=${createHmac('sha256', 'not-the-secret').update(payload).digest('hex')}`;

    const result = await makeAdapter().receiveWebhook(payload, forged, 'delivery-5', 'check_run');

    expect(result).toBe('invalid_signature');
    expect(forgeReads).toBe(0);
    expect(sent).toEqual([]);
  });

  test('a listener failure neither fails the delivery nor reaches the sender', async () => {
    const adapter = makeAdapter();
    adapter.onCheckRunCompleted(() => Promise.reject(new Error('db down')));
    const { payload, signature } = signed(checkRunCompleted(SHA));

    expect(await adapter.receiveWebhook(payload, signature, 'delivery-6', 'check_run')).toBe(
      'accepted'
    );
  });
});
