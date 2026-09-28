import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { note } from './io.ts';

/**
 * The gate script's own deadline. The `gate` node's `timeout:` in
 * `archon-validate.yaml` is only a backstop and must exceed this (a test pins the
 * pair): an engine kill ends the script before its `finally`, so only a deadline the
 * script owns lets it restore the files it quarantined.
 */
export const GATE_DEADLINE_MS = 45 * 60_000;

const TAIL_CHARS = 4000;
const QUARANTINE_DIR = 'archon-validate-quarantine';

export interface GateDiscovery {
  gate: 'run' | 'none_defined' | 'unrunnable';
  argv: string[];
  reason: string;
}

export interface GateRecord {
  ran: boolean;
  argv: string[];
  /** Null when the gate never exited on its own: not run, past the deadline, or killed by a signal. */
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  /** The log's path relative to the artifacts directory; empty when no log was opened. */
  log: string;
  tail: string;
  /** Untracked `.archon/` paths moved aside for the gate's duration. */
  quarantined: string[];
  /**
   * Why the gate could not start, or why the checkout was not left as it was found;
   * empty when neither happened. A gate record never passes with an error.
   */
  error: string;
}

export function parseGateDiscovery(value: unknown): GateDiscovery {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gate discovery must be an object.');
  }
  const { gate, argv, reason } = value as Record<string, unknown>;
  if (gate !== 'run' && gate !== 'none_defined' && gate !== 'unrunnable') {
    throw new Error('Gate discovery gate must be run, none_defined or unrunnable.');
  }
  if (!Array.isArray(argv) || !argv.every(item => typeof item === 'string' && item !== '')) {
    throw new Error('Gate discovery argv must be an array of nonempty strings.');
  }
  if (typeof reason !== 'string') throw new Error('Gate discovery reason must be a string.');
  if (gate === 'run' && argv.length === 0) {
    throw new Error('Gate discovery declared run with no argv.');
  }
  if (gate !== 'run' && argv.length !== 0) {
    throw new Error(`Gate discovery declared ${gate} but supplied an argv.`);
  }
  return { gate, argv: argv as string[], reason };
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(
      `Local git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`
    );
  }
  return result.stdout.toString();
}

function untrackedArchonPaths(root: string): string[] {
  return git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.archon'])
    .split('\0')
    .filter(entry => entry.startsWith('?? '))
    .map(entry => entry.slice(3));
}

/**
 * The run's own scaffolding is untracked `.archon/` content, and a repository gate that
 * refuses untracked files would report it rather than the change. The tracked tree is
 * the object under validation, so every untracked, non-ignored `.archon/` path is moved
 * under the git directory — same filesystem, invisible to `git status` — for the gate.
 */
function quarantine(root: string, paths: string[]): string {
  const store = join(git(root, ['rev-parse', '--absolute-git-dir']).trim(), QUARANTINE_DIR);
  if (existsSync(store)) {
    throw new Error(
      `${store} already exists: a previous gate did not restore its quarantined files. Move its contents back into the checkout, then remove it.`
    );
  }
  if (paths.length === 0) return store;
  note(`Quarantining ${paths.length} untracked .archon/ path(s) in ${store} while the gate runs.`);
  const moved: string[] = [];
  try {
    for (const path of paths) {
      const target = join(store, path);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(join(root, path), target);
      moved.push(path);
    }
  } catch (error) {
    // A failed rollback must not replace the failure that caused it.
    const unrestored = restore(root, store, moved);
    if (unrestored === undefined) throw error;
    throw new Error(`${message(error)} ${unrestored}`, { cause: error });
  }
  return store;
}

/** Moves every path back; a description of what could not be, or undefined when all were. */
function restore(root: string, store: string, paths: string[]): string | undefined {
  const unrestored: string[] = [];
  for (const path of paths) {
    const original = join(root, path);
    // The gate may have recreated the path; never overwrite what it left.
    if (existsSync(original)) {
      unrestored.push(path);
      continue;
    }
    try {
      mkdirSync(dirname(original), { recursive: true });
      renameSync(join(store, path), original);
    } catch (error) {
      unrestored.push(`${path} (${(error as Error).message})`);
    }
  }
  if (unrestored.length > 0) {
    return `Could not restore quarantined files from ${store}: ${unrestored.join(', ')}. Move them back by hand.`;
  }
  rmSync(store, { recursive: true, force: true });
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first free log name, so a resumed run keeps every attempt's evidence. */
function openLog(directory: string): { path: string; fd: number } {
  mkdirSync(directory, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const path = join(directory, attempt === 1 ? 'gate.log' : `gate-${attempt}.log`);
    try {
      return { path, fd: openSync(path, 'wx') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

function execute(
  argv: string[],
  cwd: string,
  fd: number,
  deadlineMs: number
): Promise<{ exit_code: number | null; timed_out: boolean }> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a deadline kill reaches every grandchild
    // (`bun run validate` → `bun run type-check` → `tsc`), not just the first process.
    const posix = process.platform !== 'win32';
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: process.env,
      stdio: ['ignore', fd, fd],
      detached: posix,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (posix && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    }, deadlineMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      resolve({ exit_code: timedOut ? null : code, timed_out: timedOut });
    });
  });
}

/**
 * Run the discovered gate as a subprocess of this script, never inside an agent's
 * shell, with a deadline this script enforces. Output goes to a log under
 * `validate-gate/` in the artifacts directory, and the record is written beside it.
 *
 * Always resolves a record: a gate that cannot start, or a checkout that cannot be
 * put back, is reported in `error` for the verdict to classify, never thrown past it.
 */
export async function runGate(
  cwd: string,
  artifactsDir: string,
  discovery: GateDiscovery,
  deadlineMs: number
): Promise<GateRecord> {
  const record: GateRecord = {
    ran: false,
    argv: discovery.argv,
    exit_code: null,
    timed_out: false,
    duration_ms: 0,
    log: '',
    tail: '',
    quarantined: [],
    error: '',
  };
  if (discovery.gate !== 'run') return record;
  let root: string;
  let store: string;
  let paths: string[];
  try {
    root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    paths = untrackedArchonPaths(root);
    store = quarantine(root, paths);
  } catch (error) {
    return { ...record, error: message(error) };
  }
  record.quarantined = paths;
  const errors: string[] = [];
  let logPath: string | undefined;
  try {
    const log = openLog(join(artifactsDir, 'validate-gate'));
    logPath = log.path;
    record.log = relative(artifactsDir, log.path).split('\\').join('/');
    const started = Date.now();
    try {
      Object.assign(record, await execute(discovery.argv, cwd, log.fd, deadlineMs));
      record.ran = true;
    } finally {
      closeSync(log.fd);
      record.duration_ms = Date.now() - started;
    }
    record.tail = readFileSync(log.path, 'utf8').slice(-TAIL_CHARS);
  } catch (error) {
    errors.push(message(error));
  }
  if (paths.length > 0) {
    const unrestored = restore(root, store, paths);
    if (unrestored !== undefined) errors.push(unrestored);
  }
  if (logPath !== undefined) {
    const written = { ...record, error: errors.join('\n') };
    try {
      writeFileSync(logPath.replace(/\.log$/, '.json'), JSON.stringify(written, null, 2));
    } catch (error) {
      errors.push(message(error));
    }
  }
  return { ...record, error: errors.join('\n') };
}
