/**
 * Workflow deploys (#226): what starts a deploy run, what a merge starts, what
 * Cancel reaches, and what the bar reads. The resource-start tables, the run
 * tables and workflow discovery are faked; what is under test is which project
 * each of them is asked about, and what is refused before anything starts.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
  }),
}));

mock.module('@archon/core', () => ({ loadConfig: mock(async () => ({})) }));
mock.module('../routes/github-issues', () => ({
  githubRepoOf: (url: string) => {
    const [owner, repo] = url.replace('https://github.com/', '').split('/');
    return owner && repo ? { owner, repo } : null;
  },
}));

const mockGetDefaultBranch = mock(async (_path: string): Promise<string> => 'main');
mock.module('@archon/git', () => ({
  getDefaultBranch: mockGetDefaultBranch,
  toRepoPath: (p: string) => p,
}));

const ATLAS = {
  id: 'p-atlas',
  name: 'atlas',
  default_cwd: '/repos/atlas',
  default_branch: 'main',
  repository_url: 'https://github.com/rajababa-io/atlas',
};
const VAULT = {
  id: 'p-vault',
  name: 'vault',
  default_cwd: '/repos/vault',
  default_branch: 'main',
  repository_url: 'https://github.com/rajababa-io/vault',
};
const CODEBASES: Record<string, unknown> = { [ATLAS.id]: ATLAS, [VAULT.id]: VAULT };
mock.module('@archon/core/db/codebases', () => ({
  getCodebase: mock(async (id: string) => CODEBASES[id] ?? null),
}));

type Run = {
  runId: string;
  sha: string;
  at: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  finishedAt: string | null;
};
let runsByProject: Record<string, Run[]> = {};
const mockListDeployRuns = mock(async (id: string) => runsByProject[id] ?? []);
const mockRecordDeployRun = mock(async (..._args: unknown[]) => undefined);
const mockRecordEvent = mock(async (..._args: unknown[]) => 'event-id');
const mockListEvents = mock(async (_id: string): Promise<unknown[]> => []);
const setting = (codebaseId: string, over: Record<string, unknown> = {}) => ({
  codebaseId,
  method: 'workflow' as const,
  workflowName: 'deploy',
  branch: 'main',
  deployOnMerge: true,
  updatedAt: '2026-09-28T00:00:00Z',
  updatedBy: 'you@example.com',
  ...over,
});
let mergeDeploys: ReturnType<typeof setting>[] = [];
mock.module('@archon/core/db/project-deploy', () => ({
  listDeployRuns: mockListDeployRuns,
  recordDeployRun: mockRecordDeployRun,
  recordDeployEvent: mockRecordEvent,
  listDeployEvents: mockListEvents,
  listMergeDeploysOnBranch: mock(async (branch: string) =>
    mergeDeploys.filter(d => d.branch === branch && d.deployOnMerge)
  ),
}));

const accepted: {
  receipt: { sourceInstanceId: string; deliveryId: string | null };
  bindings: {
    resource: string;
    runAsUserId: string;
    launch: { cwd: string; workflowName: string; isolation: unknown };
  }[];
}[] = [];
let replay = false;
let disposition: unknown = { status: 'admitted', requestId: 'run-new', runId: 'run-new' };
let bindingStatus = 'complete';
mock.module('@archon/core/db/resource-starts', () => ({
  acceptStartReceipt: mock(
    async (input: (typeof accepted)[number] & { receipt: { id: string } }) => {
      accepted.push(input);
      return { receiptId: input.receipt.id, replay };
    }
  ),
  getStartReceipt: mock(async () => ({
    bindings: [{ status: bindingStatus, error: 'launch_preparation_failed', disposition }],
  })),
}));

mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(async (_p: string, id: string) => ({
    id: `user:${id}`,
  })),
}));

class CancelRefusedError extends Error {}
const mockCancelWorkflow = mock(async (_runId: string): Promise<unknown> => ({}));
mock.module('@archon/core/operations/workflow-operations', () => ({
  CancelRefusedError,
  cancelWorkflow: mockCancelWorkflow,
}));

let discovered: { name: string; source: string }[] = [];
mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mock(async () => ({
    workflows: discovered.map(w => ({ workflow: { name: w.name }, source: w.source })),
    errors: [],
  })),
}));

const TIP = 'b'.repeat(40);
const mockReadWaiting = mock(
  async (_c: unknown, _branch: string, _live: string | null): Promise<unknown> => ({
    waiting: { tipSha: TIP, prs: [], more: false },
    reason: null,
  })
);
mock.module('./deploy-control', () => ({
  readWaiting: mockReadWaiting,
  resetWaitingCache: mock(() => undefined),
}));

const {
  cancelWorkflowDeploy,
  deployMergedBranch,
  deployWorkflowNow,
  getWorkflowDeployLog,
  getWorkflowDeployView,
  readDeploySetup,
} = await import('./workflow-deploy');

const drains: string[] = [];
const host = {
  hostId: 'archon-box',
  isDraining: () => false,
  requestDrain: async (): Promise<void> => {
    drains.push('drain');
  },
};

beforeEach(() => {
  accepted.length = 0;
  drains.length = 0;
  replay = false;
  disposition = { status: 'admitted', requestId: 'run-new', runId: 'run-new' };
  bindingStatus = 'complete';
  runsByProject = {};
  mergeDeploys = [];
  discovered = [
    { name: 'deploy', source: 'project' },
    { name: 'archon-assist', source: 'bundled' },
  ];
  mockRecordDeployRun.mockClear();
  mockRecordEvent.mockClear();
  mockCancelWorkflow.mockClear();
});

describe('the Set up deploys picker', () => {
  test("offers the repository's own workflows, defaulting to deploy and the default branch", async () => {
    expect(await readDeploySetup(ATLAS as never)).toEqual({
      branch: 'main',
      workflows: ['deploy'],
      workflow: 'deploy',
    });
  });

  test('pre-selects no workflow when the project has no deploy workflow', async () => {
    discovered = [{ name: 'build', source: 'project' }];
    const setup = await readDeploySetup({ ...ATLAS, default_branch: null } as never);
    expect(setup).toEqual({ branch: 'main', workflows: ['build'], workflow: null });
    expect(mockGetDefaultBranch).toHaveBeenCalledWith(ATLAS.default_cwd);
  });
});

describe('Deploy now', () => {
  test("starts the project's workflow at the branch tip, in its own slot, and records it", async () => {
    const result = await deployWorkflowNow(
      ATLAS as never,
      setting(ATLAS.id),
      TIP,
      'you@example.com',
      host
    );
    expect(result).toEqual({ ok: true, runId: 'run-new' });
    expect(accepted).toHaveLength(1);
    const binding = accepted[0]!.bindings[0]!;
    expect(binding.resource).toBe(`deploy:${ATLAS.id}`);
    expect(binding.runAsUserId).toBe('user:you@example.com');
    expect(binding.launch).toMatchObject({
      cwd: ATLAS.default_cwd,
      workflowName: 'deploy',
      isolation: { kind: 'worktree', baseOverride: 'main' },
    });
    expect(drains).toEqual(['drain']);
    expect(mockRecordDeployRun).toHaveBeenCalledWith(ATLAS.id, 'run-new', TIP);
    expect(mockRecordEvent).toHaveBeenCalledWith(
      ATLAS.id,
      'deploy_requested',
      'you@example.com',
      TIP
    );
  });

  test('a missing workflow starts nothing', async () => {
    discovered = [{ name: 'build', source: 'project' }];
    const result = await deployWorkflowNow(ATLAS as never, setting(ATLAS.id), TIP, 'you', host);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(accepted).toHaveLength(0);
  });

  test('a bundled workflow of the same name does not count as the project having one', async () => {
    discovered = [{ name: 'deploy', source: 'bundled' }];
    const result = await deployWorkflowNow(ATLAS as never, setting(ATLAS.id), TIP, 'you', host);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(accepted).toHaveLength(0);
  });

  test('while the server drains for its replacement nothing is accepted', async () => {
    const draining = { ...host, isDraining: () => true };
    const result = await deployWorkflowNow(ATLAS as never, setting(ATLAS.id), TIP, 'you', draining);
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining('restarting'),
    });
    expect(accepted).toHaveLength(0);
  });

  test('without a trigger host nothing is accepted that would never run', async () => {
    const result = await deployWorkflowNow(ATLAS as never, setting(ATLAS.id), TIP, 'you', null);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(accepted).toHaveLength(0);
  });

  test('a branch that moved since the person looked is refused', async () => {
    const result = await deployWorkflowNow(
      ATLAS as never,
      setting(ATLAS.id),
      'c'.repeat(40),
      'you',
      host
    );
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(accepted).toHaveLength(0);
  });

  test('a deploy of this project already running is refused; one of another project is not in the way', async () => {
    runsByProject[VAULT.id] = [
      { runId: 'v1', sha: TIP, at: '2026-09-28T00:00:00Z', status: 'running', finishedAt: null },
    ];
    expect(
      await deployWorkflowNow(ATLAS as never, setting(ATLAS.id), TIP, 'you', host)
    ).toMatchObject({ ok: true });

    runsByProject[ATLAS.id] = [
      { runId: 'a1', sha: TIP, at: '2026-09-28T00:00:00Z', status: 'running', finishedAt: null },
    ];
    accepted.length = 0;
    expect(
      await deployWorkflowNow(ATLAS as never, setting(ATLAS.id), TIP, 'you', host)
    ).toMatchObject({ ok: false, status: 409 });
    expect(accepted).toHaveLength(0);
  });

  test('a start the engine refused is reported, and nothing is recorded as a deploy', async () => {
    bindingStatus = 'failed';
    disposition = null;
    const result = await deployWorkflowNow(ATLAS as never, setting(ATLAS.id), TIP, 'you', host);
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(mockRecordDeployRun).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });
});

describe('a merged pull request', () => {
  const merge = (over: Partial<{ branch: string; name: string }> = {}) => ({
    repo: { owner: 'rajababa-io', name: over.name ?? 'atlas' },
    branch: over.branch ?? 'main',
    sha: TIP,
    pr: 12,
  });

  test('deploys the project with the switch on, on the matching repository and branch', async () => {
    mergeDeploys = [setting(ATLAS.id), setting(VAULT.id)];
    await deployMergedBranch(merge(), host);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.bindings[0]!.resource).toBe(`deploy:${ATLAS.id}`);
    expect(accepted[0]!.receipt.deliveryId).toBe('rajababa-io/atlas#12');
    // The person who set the switch owns the deploys it starts.
    expect(accepted[0]!.bindings[0]!.runAsUserId).toBe('user:you@example.com');
    expect(mockRecordDeployRun).toHaveBeenCalledWith(ATLAS.id, 'run-new', TIP);
  });

  test('starts nothing with the switch off', async () => {
    mergeDeploys = [setting(ATLAS.id, { deployOnMerge: false })];
    await deployMergedBranch(merge(), host);
    expect(accepted).toHaveLength(0);
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  test('starts nothing for a merge into another branch', async () => {
    mergeDeploys = [setting(ATLAS.id)];
    await deployMergedBranch(merge({ branch: 'dev' }), host);
    expect(accepted).toHaveLength(0);
  });

  test('a redelivered merge starts no second deploy, and is not a failure', async () => {
    mergeDeploys = [setting(ATLAS.id)];
    replay = true;
    await deployMergedBranch(merge(), host);
    expect(drains).toEqual([]);
    expect(mockRecordDeployRun).not.toHaveBeenCalled();
  });

  test('starts nothing when no person owns the switch', async () => {
    mergeDeploys = [setting(ATLAS.id, { updatedBy: null })];
    await deployMergedBranch(merge(), host);
    expect(accepted).toHaveLength(0);
    expect(mockRecordDeployRun).not.toHaveBeenCalled();
  });

  test('a deploy that did not start fails the merge, so a redelivery can try again', async () => {
    mergeDeploys = [setting(ATLAS.id)];
    discovered = [];
    await expect(deployMergedBranch(merge(), host)).rejects.toThrow(ATLAS.id);
    expect(accepted).toHaveLength(0);
  });
});

describe('Cancel deploy', () => {
  test("cancels this project's running deploy run, and only that", async () => {
    runsByProject[ATLAS.id] = [
      { runId: 'a2', sha: TIP, at: '2026-09-28T01:00:00Z', status: 'running', finishedAt: null },
      {
        runId: 'a1',
        sha: 'a'.repeat(40),
        at: '2026-09-28T00:00:00Z',
        status: 'completed',
        finishedAt: '2026-09-28T00:05:00Z',
      },
    ];
    runsByProject[VAULT.id] = [
      { runId: 'v1', sha: TIP, at: '2026-09-28T01:00:00Z', status: 'running', finishedAt: null },
    ];
    expect(await cancelWorkflowDeploy(ATLAS.id, 'you')).toEqual({ ok: true, runId: 'a2' });
    expect(mockCancelWorkflow.mock.calls).toEqual([['a2']]);
    expect(mockRecordEvent).toHaveBeenCalledWith(ATLAS.id, 'deploy_cancelled', 'you', TIP);
  });

  test("with nothing of its own running, another project's run is left alone", async () => {
    runsByProject[VAULT.id] = [
      { runId: 'v1', sha: TIP, at: '2026-09-28T01:00:00Z', status: 'running', finishedAt: null },
    ];
    expect(await cancelWorkflowDeploy(ATLAS.id, 'you')).toMatchObject({ ok: false, status: 409 });
    expect(mockCancelWorkflow).not.toHaveBeenCalled();
  });

  test("the engine's refusal is passed on, and no cancel is logged", async () => {
    runsByProject[ATLAS.id] = [
      { runId: 'a2', sha: TIP, at: '2026-09-28T01:00:00Z', status: 'running', finishedAt: null },
    ];
    mockCancelWorkflow.mockImplementationOnce(async () => {
      throw new CancelRefusedError('No live owner answered.');
    });
    expect(await cancelWorkflowDeploy(ATLAS.id, 'you')).toEqual({
      ok: false,
      status: 409,
      error: 'No live owner answered.',
    });
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });
});

describe('the bar and the log', () => {
  test('live is the newest completed deploy; a later run in flight is the progress', async () => {
    runsByProject[ATLAS.id] = [
      { runId: 'a3', sha: TIP, at: '2026-09-28T02:00:00Z', status: 'running', finishedAt: null },
      {
        runId: 'a2',
        sha: 'f'.repeat(40),
        at: '2026-09-28T01:00:00Z',
        status: 'failed',
        finishedAt: '2026-09-28T01:01:00Z',
      },
      {
        runId: 'a1',
        sha: 'a'.repeat(40),
        at: '2026-09-28T00:00:00Z',
        status: 'completed',
        finishedAt: '2026-09-28T00:05:00Z',
      },
    ];
    const view = await getWorkflowDeployView(ATLAS as never, setting(ATLAS.id), host);
    expect(view.live).toEqual({ sha: 'a'.repeat(40), deployedAt: '2026-09-28T00:05:00Z' });
    expect(view.run).toMatchObject({ id: 'a3', status: 'running' });
    expect(view.cancellable).toBe(true);
    expect(view.blocked).toBeNull();
    expect(mockReadWaiting.mock.calls.at(-1)?.[2]).toBe('a'.repeat(40));
  });

  test('never deployed: the whole branch is waiting, not up to date', async () => {
    const view = await getWorkflowDeployView(ATLAS as never, setting(ATLAS.id), host);
    expect(view.live.sha).toBeNull();
    expect(view.waiting).toEqual({ tipSha: TIP, prs: [], more: false });
    expect(mockReadWaiting.mock.calls.at(-1)?.[2]).toBeNull();
  });

  test('a missing workflow is named as what greys Deploy now', async () => {
    discovered = [];
    const view = await getWorkflowDeployView(ATLAS as never, setting(ATLAS.id), host);
    expect(view.blocked).toBe('workflow-missing');
    expect((await getWorkflowDeployView(ATLAS as never, setting(ATLAS.id), null)).blocked).toBe(
      'no-trigger-host'
    );
  });

  test('the log shows each run starting and how it ended', async () => {
    runsByProject[ATLAS.id] = [
      {
        runId: 'a1',
        sha: TIP,
        at: '2026-09-28T00:00:00Z',
        status: 'completed',
        finishedAt: '2026-09-28T00:05:00Z',
      },
    ];
    expect((await getWorkflowDeployLog(ATLAS.id)).map(e => e.kind)).toEqual(['ok', 'started']);
  });
});
