import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  GATE_DEADLINE_MS,
  parseGateDiscovery,
  runGate,
  type GateDiscovery,
} from '../.archon/workflows/sdlc/.shared/gate';

const track = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture(): { cwd: string; artifacts: string; quarantine: string } {
  const root = track(mkdtempSync(join(tmpdir(), 'validate-gate-')));
  const cwd = join(root, 'repo');
  const artifacts = join(root, 'artifacts');
  mkdirSync(join(cwd, '.archon'), { recursive: true });
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(cwd, '.archon', 'kept.md'), 'tracked');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'initial');
  return { cwd, artifacts, quarantine: join(cwd, '.git', 'archon-validate-quarantine') };
}

function run(...argv: string[]): GateDiscovery {
  return { gate: 'run', argv, reason: '' };
}

const bun = process.execPath;
// Fails when anything untracked is visible, as a repository cleanliness gate would.
const cleanlinessGate = `const out = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all']).stdout.toString(); if (out !== '') { console.error(out); process.exitCode = 1 }`;

describe('validate gate', () => {
  it('stops a gate at its deadline instead of waiting for it', async () => {
    const { cwd, artifacts } = fixture();
    const started = Date.now();
    const record = await runGate(cwd, artifacts, run(bun, '-e', 'await Bun.sleep(60_000)'), 300);
    expect(record).toMatchObject({ ran: true, timed_out: true, exit_code: null });
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it.skipIf(process.platform === 'win32')(
    'kills the whole process group at the deadline',
    async () => {
      const { cwd, artifacts } = fixture();
      const pidFile = join(artifacts, 'grandchild.pid');
      mkdirSync(artifacts, { recursive: true });
      const script = `const c = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(60_000)']); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); await c.exited;`;
      const record = await runGate(cwd, artifacts, run(bun, '-e', script), 1000);
      expect(record.timed_out).toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await Bun.sleep(100);
      expect(() => process.kill(pid, 0)).toThrow();
    }
  );

  it('moves untracked .archon/ paths aside for the gate and restores them', async () => {
    const { cwd, artifacts, quarantine } = fixture();
    mkdirSync(join(cwd, '.archon', 'injected'));
    writeFileSync(join(cwd, '.archon', 'injected', 'x.md'), 'scaffolding');
    const record = await runGate(cwd, artifacts, run(bun, '-e', cleanlinessGate), GATE_DEADLINE_MS);
    expect(record).toMatchObject({ exit_code: 0, quarantined: ['.archon/injected/x.md'] });
    expect(readFileSync(join(cwd, '.archon', 'injected', 'x.md'), 'utf8')).toBe('scaffolding');
    expect(readFileSync(join(cwd, '.archon', 'kept.md'), 'utf8')).toBe('tracked');
    expect(existsSync(quarantine)).toBe(false);
  });

  it('restores quarantined paths when the gate times out', async () => {
    const { cwd, artifacts, quarantine } = fixture();
    writeFileSync(join(cwd, '.archon', 'injected.md'), 'scaffolding');
    const record = await runGate(cwd, artifacts, run(bun, '-e', 'await Bun.sleep(60_000)'), 300);
    expect(record).toMatchObject({ timed_out: true, quarantined: ['.archon/injected.md'] });
    expect(readFileSync(join(cwd, '.archon', 'injected.md'), 'utf8')).toBe('scaffolding');
    expect(existsSync(quarantine)).toBe(false);
  });

  it('refuses to start over a quarantine a previous gate never restored', async () => {
    const { cwd, artifacts, quarantine } = fixture();
    mkdirSync(quarantine);
    writeFileSync(join(cwd, '.archon', 'injected.md'), 'scaffolding');
    const marker = join(artifacts, 'spawned');
    await expect(
      runGate(
        cwd,
        artifacts,
        run(bun, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`),
        5000
      )
    ).rejects.toThrow('did not restore');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(cwd, '.archon', 'injected.md'))).toBe(true);
  });

  it('records the exit code and output, keeping every attempt', async () => {
    const { cwd, artifacts } = fixture();
    const gate = run(
      bun,
      '-e',
      `console.log('to stdout'); console.error('to stderr'); process.exitCode = 3`
    );
    const first = await runGate(cwd, artifacts, gate, GATE_DEADLINE_MS);
    expect(first).toMatchObject({ exit_code: 3, timed_out: false, log: 'validate-gate/gate.log' });
    expect(first.tail).toContain('to stdout');
    expect(first.tail).toContain('to stderr');
    expect(JSON.parse(readFileSync(join(artifacts, 'validate-gate', 'gate.json'), 'utf8'))).toEqual(
      first
    );
    const second = await runGate(cwd, artifacts, gate, GATE_DEADLINE_MS);
    expect(second.log).toBe('validate-gate/gate-2.log');
    expect(readFileSync(join(artifacts, 'validate-gate', 'gate.log'), 'utf8')).toContain(
      'to stdout'
    );
  });

  it('runs nothing when discovery found no gate to run', async () => {
    const { cwd, artifacts } = fixture();
    const record = await runGate(
      cwd,
      artifacts,
      { gate: 'none_defined', argv: [], reason: '' },
      300
    );
    expect(record).toMatchObject({ ran: false, exit_code: null, log: '' });
    expect(existsSync(join(artifacts, 'validate-gate'))).toBe(false);
  });

  it('refuses a discovery whose argv contradicts its gate', () => {
    expect(() => parseGateDiscovery({ gate: 'run', argv: [], reason: '' })).toThrow('no argv');
    expect(() => parseGateDiscovery({ gate: 'none_defined', argv: ['bun'], reason: '' })).toThrow(
      'supplied an argv'
    );
  });

  it('keeps the gate node backstop above the script deadline', () => {
    const workflow = Bun.YAML.parse(
      readFileSync(
        join(import.meta.dir, '../.archon/workflows/sdlc/validate/archon-validate.yaml'),
        'utf8'
      )
    ) as { nodes: { id: string; timeout?: number }[] };
    const gate = workflow.nodes.find(node => node.id === 'gate');
    expect(gate?.timeout).toBeGreaterThan(GATE_DEADLINE_MS);
  });
});
