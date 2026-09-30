import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  runDiskReclaim,
  findNodeModules,
  type DiskReclaimSettings,
  type DiskReclaimSources,
  type DiskReclaimProcessState,
} from './disk-reclaim';

const trackTempRoot = trackTempRoots();

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A git worktree with committed code, an uncommitted edit, and two installs. */
async function makeWorktree(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, 'packages', 'a', 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(dir, 'node_modules', 'dep', 'index.js'), 'x'.repeat(4096));
  await writeFile(join(dir, 'packages', 'a', 'node_modules', 'dep', 'index.js'), 'y');
  await writeFile(join(dir, 'code.ts'), 'committed\n');
  await writeFile(join(dir, '.gitignore'), 'node_modules\n');
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  };
  git('init', '-q');
  git('add', 'code.ts', '.gitignore');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  await writeFile(join(dir, 'code.ts'), 'committed\nuncommitted edit\n');
  return dir;
}

interface Env {
  id: string;
  working_path: string;
  created_at: Date;
}

function makeSources(
  envs: Env[],
  over: Partial<DiskReclaimSources> = {}
): DiskReclaimSources & { cacheCleared: number } {
  const sources = {
    cacheCleared: 0,
    listActiveEnvironments: async () => envs,
    getLiveRunOwningEnv: async () => null,
    getEnvConversationActivity: async () => [{ platform_conversation_id: 'chat-1', days_idle: 3 }],
    hasUnfinishedWorkflowRun: async () => false,
    bunCacheDir: async () => null,
    clearBunCache: async () => {
      sources.cacheCleared++;
    },
    ...over,
  };
  return sources;
}

const quiet: DiskReclaimProcessState = {
  isConversationBusy: () => false,
  isProcessQuiet: () => true,
};

function settingsFor(root: string, over: Partial<DiskReclaimSettings> = {}): DiskReclaimSettings {
  return {
    idleHours: 24,
    alertPercent: 100,
    bunCacheMaxBytes: 4 * 1024 ** 3,
    pingUrl: undefined,
    measurePath: root,
    ledgerPath: join(root, 'logs', 'disk-reclaim.log'),
    ...over,
  };
}

async function setup(): Promise<{ root: string; dir: string; env: Env }> {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'disk-reclaim-')));
  const dir = await makeWorktree(root, 'wt');
  return { root, dir, env: { id: 'env-1', working_path: dir, created_at: new Date(0) } };
}

describe('runDiskReclaim', () => {
  test('removes node_modules from an idle worktree and keeps its code and edits', async () => {
    const { root, dir, env } = await setup();
    const report = await runDiskReclaim(quiet, settingsFor(root), makeSources([env]));

    expect(report?.worktrees.map(w => w.removed)).toEqual([
      [join(dir, 'node_modules'), join(dir, 'packages', 'a', 'node_modules')],
    ]);
    expect(await exists(join(dir, 'node_modules'))).toBe(false);
    expect(await exists(join(dir, 'packages', 'a', 'node_modules'))).toBe(false);
    expect(await readFile(join(dir, 'code.ts'), 'utf8')).toBe('committed\nuncommitted edit\n');
    expect(await exists(join(dir, '.git'))).toBe(true);

    const ledger = (await readFile(join(root, 'logs', 'disk-reclaim.log'), 'utf8')).trim();
    expect(JSON.parse(ledger).worktrees[0].envId).toBe('env-1');
  });

  test('keeps a worktree whose chat has a turn in flight', async () => {
    const { root, dir, env } = await setup();
    const busy: DiskReclaimProcessState = {
      isConversationBusy: id => id === 'chat-1',
      isProcessQuiet: () => false,
    };
    const report = await runDiskReclaim(busy, settingsFor(root), makeSources([env]));

    expect(report?.worktrees).toEqual([]);
    expect(report?.kept[0]?.reason).toContain('turn in flight');
    expect(await exists(join(dir, 'node_modules'))).toBe(true);
  });

  test('keeps a worktree a workflow run can still claim', async () => {
    const { root, dir, env } = await setup();
    const sources = makeSources([env], {
      getLiveRunOwningEnv: async () => ({ id: 'run-12345678', status: 'paused' }),
    });
    const report = await runDiskReclaim(quiet, settingsFor(root), sources);

    expect(report?.kept[0]?.reason).toBe('run run-1234 is paused');
    expect(await exists(join(dir, 'node_modules'))).toBe(true);
  });

  test('keeps a worktree touched inside the idle window', async () => {
    const { root, dir, env } = await setup();
    const sources = makeSources([env], {
      getEnvConversationActivity: async () => [
        { platform_conversation_id: 'old', days_idle: 9 },
        { platform_conversation_id: 'recent', days_idle: 0.25 },
      ],
    });
    const report = await runDiskReclaim(quiet, settingsFor(root), sources);

    expect(report?.kept[0]?.reason).toContain('active 6.0h ago');
    expect(await exists(join(dir, 'node_modules'))).toBe(true);
  });

  test('judges a conversation-less environment by its own age', async () => {
    const { root, dir, env } = await setup();
    const sources = makeSources([{ ...env, created_at: new Date() }], {
      getEnvConversationActivity: async () => [],
    });
    const report = await runDiskReclaim(quiet, settingsFor(root), sources);

    expect(report?.kept).toHaveLength(1);
    expect(await exists(join(dir, 'node_modules'))).toBe(true);
  });

  test('never deletes a node_modules that git tracks', async () => {
    const { root, dir, env } = await setup();
    execFileSync('git', ['-C', dir, 'add', '-f', 'node_modules/dep/index.js'], { stdio: 'ignore' });
    const report = await runDiskReclaim(quiet, settingsFor(root), makeSources([env]));

    expect(report?.kept[0]?.reason).toBe('node_modules is tracked by git');
    expect(await exists(join(dir, 'packages', 'a', 'node_modules'))).toBe(true);
  });

  test('skips an environment whose worktree is gone', async () => {
    const { root, env } = await setup();
    const report = await runDiskReclaim(
      quiet,
      settingsFor(root),
      makeSources([{ ...env, working_path: join(root, 'missing') }])
    );
    expect(report?.worktrees).toEqual([]);
    expect(report?.errors).toEqual([]);
  });

  describe('bun cache', () => {
    async function withCache(): Promise<{ root: string; cache: string }> {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'disk-reclaim-cache-')));
      const cache = join(root, 'cache');
      await mkdir(join(cache, 'pkg'), { recursive: true });
      await writeFile(join(cache, 'pkg', 'blob'), 'z'.repeat(2048));
      return { root, cache };
    }

    test('clears an oversized cache when nothing is running', async () => {
      const { root, cache } = await withCache();
      const sources = makeSources([], { bunCacheDir: async () => cache });
      const report = await runDiskReclaim(
        quiet,
        settingsFor(root, { bunCacheMaxBytes: 1024 }),
        sources
      );
      expect(report?.bunCache).toMatchObject({ dir: cache, cleared: true });
      expect(sources.cacheCleared).toBe(1);
    });

    test('leaves it while a turn is in flight or a run executes', async () => {
      const { root, cache } = await withCache();
      const busy = { ...quiet, isProcessQuiet: () => false };
      const s1 = makeSources([], { bunCacheDir: async () => cache });
      const r1 = await runDiskReclaim(busy, settingsFor(root, { bunCacheMaxBytes: 1024 }), s1);
      expect(r1?.bunCache?.reason).toBe('a conversation holds a turn');

      const s2 = makeSources([], {
        bunCacheDir: async () => cache,
        hasUnfinishedWorkflowRun: async () => true,
      });
      const r2 = await runDiskReclaim(quiet, settingsFor(root, { bunCacheMaxBytes: 1024 }), s2);
      expect(r2?.bunCache?.reason).toBe('a workflow run is executing');
      expect(s1.cacheCleared + s2.cacheCleared).toBe(0);
    });

    test('leaves a cache under the cap', async () => {
      const { root, cache } = await withCache();
      const sources = makeSources([], { bunCacheDir: async () => cache });
      const report = await runDiskReclaim(quiet, settingsFor(root), sources);
      expect(report?.bunCache?.cleared).toBe(false);
      expect(sources.cacheCleared).toBe(0);
    });
  });

  describe('ping', () => {
    const hits: { path: string; body: string }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        hits.push({ path: new URL(req.url).pathname, body: await req.text() });
        return new Response('OK');
      },
    });
    afterAll(() => {
      void server.stop(true);
    });
    const url = `http://127.0.0.1:${String(server.port)}/ping/abc`;

    test('reports success under the alert threshold', async () => {
      hits.length = 0;
      const { root, env } = await setup();
      const report = await runDiskReclaim(
        quiet,
        settingsFor(root, { pingUrl: url }),
        makeSources([env])
      );
      expect(report?.alert).toBe(false);
      expect(hits.map(h => h.path)).toEqual(['/ping/abc']);
      expect(hits[0]?.body).toContain('node_modules removed from 1 worktree(s)');
    });

    test('reports failure at or over the alert threshold', async () => {
      hits.length = 0;
      const { root } = await setup();
      const report = await runDiskReclaim(
        quiet,
        settingsFor(root, { pingUrl: url, alertPercent: 0.01 }),
        makeSources([])
      );
      expect(report?.alert).toBe(true);
      expect(hits.map(h => h.path)).toEqual(['/ping/abc/fail']);
    });

    test('reports failure when the run itself breaks', async () => {
      hits.length = 0;
      const { root } = await setup();
      const report = await runDiskReclaim(
        quiet,
        settingsFor(root, { pingUrl: url }),
        makeSources([], {
          listActiveEnvironments: async () => {
            throw new Error('db down');
          },
        })
      );
      expect(report).toBeNull();
      expect(hits).toEqual([{ path: '/ping/abc/fail', body: 'disk reclaim failed: db down' }]);
    });
  });
});

describe('findNodeModules', () => {
  test('finds outermost installs without entering .git or following symlinks', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'disk-reclaim-find-')));
    const outside = trackTempRoot(await mkdtemp(join(tmpdir(), 'disk-reclaim-outside-')));
    await mkdir(join(outside, 'node_modules'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'x', 'node_modules'), { recursive: true });
    await mkdir(join(root, '.git', 'node_modules'), { recursive: true });
    await symlink(outside, join(root, 'linked'));

    expect(await findNodeModules(root)).toEqual([join(root, 'node_modules')]);
  });
});
