import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { discoverPlugins } from './discovery';
import { dispatchForge } from './dispatch';
import { runForgeReadConformance } from './outbound-conformance';

let root: string;
let plugins: string;
let executable: string;

// The compile is fixture setup, and on Windows it is the costliest process this file
// starts. Kept inside the test it shared one budget with the two plugin launches under
// test, and on the loaded `windows-latest` runner, where any single spawn can take 5-15 s
// (see scripts/bun-test-command.ts), three spawns can exhaust a budget sized for one:
// run 36277089971 timed out with a plugin launch still alive at the deadline. Here the
// budget covers only discovery and dispatch.
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-external-forge-'));
  plugins = join(root, 'plugins');
  await mkdir(plugins);
  const entry = join(root, 'fixture.ts');
  await writeFile(entry, await readFile(join(import.meta.dir, 'fixtures', 'external-plugin.ts')));
  executable = join(
    plugins,
    `archon-forge-external-fixture${process.platform === 'win32' ? '.exe' : ''}`
  );
  const build = Bun.spawnSync(
    [process.execPath, 'build', '--compile', entry, '--outfile', executable],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' }
  );
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
});

afterAll(async () => {
  await removeTempTree(root);
});

test('discovers and runs an independently installed executable outside the source tree', async () => {
  const env = {
    ...process.env,
    EXTERNAL_FORGE_TOKEN: 'fixture-credential',
    UNRELATED_SECRET: 'must-not-be-inherited',
  };
  const discovery = await discoverPlugins({
    config: { pluginDirs: [plugins], scanPath: false },
    env,
    includeDefaultDir: false,
  });
  expect(discovery.plugins.map(plugin => plugin.command)).toEqual([executable]);
  const request = {
    operationId: 'external-observation',
    op: 'checks.state' as const,
    ref: { repo: { host: 'fixture.invalid', path: 'group/project' }, number: 42 },
  };
  const missing = await dispatchForge(request, { discovery, env: {} });
  expect(missing.response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
  const failures = await runForgeReadConformance(
    async input => (await dispatchForge(input, { discovery, env })).response,
    [
      {
        name: 'externally installed producer',
        request,
        expected: {
          revision: 'fixture-revision',
          state: 'green',
          units: [{ kind: 'commit_status', id: 'external-1' }],
        },
      },
    ]
  );
  expect(failures).toEqual([]);
});
