/**
 * Tests for `scripts/deploy-on-request.sh` — the host-side half of the deploy.
 *
 * What is under test is the script's REPORTING, not its deploying. This is the
 * only thing that says afterwards what happened, and on 2026-09-23 it said the
 * wrong thing twice in one run: it declared "the box is running whatever it was
 * before" when the swap had in fact happened, and it truncated the failing
 * attempt's log as soon as the next request arrived, so the reason was gone
 * before anyone read it.
 *
 * Driven as a SUBPROCESS with `docker` and the deploy itself stubbed on PATH.
 * The contract is what ends up in the log, the rotated log, and the history
 * file — none of which needs a real container to observe.
 */
import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

/**
 * POSIX only. These tests drive real shell scripts — they spawn `bash`, write
 * executable stubs onto PATH with a `#!/usr/bin/env bash` shebang, and rely on
 * `chmod` actually granting execute. Windows has none of that, and neither does
 * the thing under test: `deploy-local.sh` and `deploy-on-request.sh` run as root
 * on the Linux host that owns the Docker daemon, and can never run anywhere else.
 *
 * Skipped rather than ported, because a Windows-compatible version of these would
 * be exercising a deployment that does not exist. The suites became visible to the
 * Windows CI job when the deploy scripts reached `dev`; before that they lived only
 * on `local/deploy`, which no Windows runner builds.
 */
const describePosix = process.platform === 'win32' ? describe.skip : describe;

const trackTempRoot = trackTempRoots();

const SCRIPT = join(import.meta.dir, 'deploy-on-request.sh');
const WANT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

interface Sandbox {
  volume: string;
  bin: string;
  deploy: string;
  deployDir: string;
}

/**
 * A stub `docker` that answers the two questions the script asks, keyed by the
 * command text rather than by argument position — the real invocation buries it
 * behind `compose exec -T -u root <service> sh -lc`.
 */
function writeDockerStub(bin: string, headSha: string, runningSha: string): void {
  const stub = join(bin, 'docker');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *"rev-parse HEAD"*) printf '%s\\n' '${headSha}'; exit 0 ;;
    *".deployed-sha"*) ${runningSha === '' ? 'exit 1' : `printf '%s\\n' '${runningSha}'; exit 0`} ;;
  esac
done
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(stub, 0o755);
}

/** A stand-in deploy that prints what deploy-local.sh's `die` would, then fails. */
function writeFailingDeploy(path: string, reason: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nprintf 'STOPPED: %s\\n' '${reason}' >&2\nexit 1\n`, {
    mode: 0o755,
  });
  chmodSync(path, 0o755);
}

/** A stand-in deploy that hangs, so the script can be signalled mid-flight. */
function writeHangingDeploy(path: string): void {
  writeFileSync(path, '#!/usr/bin/env bash\necho started\nsleep 30\n', { mode: 0o755 });
  chmodSync(path, 0o755);
}

function writeSucceedingDeploy(path: string): void {
  writeFileSync(path, '#!/usr/bin/env bash\necho did the thing\nexit 0\n', { mode: 0o755 });
  chmodSync(path, 0o755);
}

function sandbox(name: string): Sandbox {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `deploy-on-request-${name}-`)));
  const volume = join(root, 'volume');
  const bin = join(root, 'bin');
  const deployDir = join(root, 'deploy-dir');
  mkdirSync(volume, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(deployDir, { recursive: true });
  return { volume, bin, deploy: join(root, 'deploy.sh'), deployDir };
}

function spawnRun(box: Sandbox, request: string): Bun.Subprocess {
  writeFileSync(join(box.volume, 'deploy-request'), `${request}\n`);
  return Bun.spawn(['bash', SCRIPT], {
    env: {
      ...process.env,
      PATH: `${box.bin}:${process.env.PATH ?? ''}`,
      VOLUME: box.volume,
      DEPLOY: box.deploy,
      DEPLOY_DIR: box.deployDir,
      SOURCE_DIR: '/source',
      SERVICE: 'app',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function run(box: Sandbox, request: string): Promise<number> {
  return spawnRun(box, request).exited;
}

/** Wait for a line the script writes, so the signal lands mid-deploy. */
async function waitForLog(box: Sandbox, needle: string): Promise<void> {
  const log = join(box.volume, 'deploy-last.log');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(log) && readFileSync(log, 'utf8').includes(needle)) return;
    await Bun.sleep(50);
  }
  throw new Error(`log never mentioned ${needle}`);
}

const read = (path: string): string => readFileSync(path, 'utf8');

describePosix('a failure that swapped the container anyway', () => {
  test('says the swap happened rather than claiming nothing changed', async () => {
    const box = sandbox('swapped');
    writeDockerStub(box.bin, WANT, WANT);
    writeFailingDeploy(box.deploy, 'swapped, but it never became healthy');

    expect(await run(box, WANT)).toBe(1);

    const log = read(join(box.volume, 'deploy-last.log'));
    expect(log).toContain('the swap DID happen');
    expect(log).toContain(WANT);
    expect(log).not.toContain('running whatever it was before');
  });

  test('records the failing reason in history, not just an exit code', async () => {
    const box = sandbox('reason');
    writeDockerStub(box.bin, WANT, WANT);
    writeFailingDeploy(box.deploy, 'swapped, but it never became healthy');

    await run(box, WANT);

    const history = read(join(box.volume, 'deploy-history'));
    expect(history).toContain('never became healthy');
    expect(history).toContain(`running ${WANT}`);
  });

  test('reports the older commit when the swap did NOT happen', async () => {
    const box = sandbox('not-swapped');
    writeDockerStub(box.bin, WANT, OTHER);
    writeFailingDeploy(box.deploy, 'the box never went quiet');

    await run(box, WANT);

    expect(read(join(box.volume, 'deploy-last.log'))).toContain(`the box is running ${OTHER}`);
  });

  test('an unreadable container is said to be unreadable, never assumed', async () => {
    const box = sandbox('unreadable');
    writeDockerStub(box.bin, WANT, '');
    writeFailingDeploy(box.deploy, 'build failed');

    await run(box, WANT);

    const log = read(join(box.volume, 'deploy-last.log'));
    expect(log).toContain('cannot say what it is running');
    expect(read(join(box.volume, 'deploy-history'))).toContain('running unknown');
  });
});

describePosix('the losing attempt survives the next request', () => {
  test('the previous log is kept beside the current one', async () => {
    const box = sandbox('rotate');
    writeDockerStub(box.bin, WANT, WANT);
    writeFailingDeploy(box.deploy, 'first attempt died here');
    await run(box, WANT);

    writeSucceedingDeploy(box.deploy);
    await run(box, WANT);

    expect(read(join(box.volume, 'deploy-last.log'))).toContain('DEPLOYED');
    expect(read(join(box.volume, 'deploy-prev.log'))).toContain('first attempt died here');
  });
});

describePosix('a deploy that parked work', () => {
  const REPORT =
    'parked 3 chats, 1 queued message, 1 workflow run; resumed 3 chats, 1 queued message, 1 workflow run';

  test('the history line says what was parked and what came back', async () => {
    const box = sandbox('parked');
    writeDockerStub(box.bin, WANT, WANT);
    writeFileSync(
      box.deploy,
      `#!/usr/bin/env bash\nprintf '%s\\n' '${REPORT}' >"$PARK_REPORT_FILE"\nexit 0\n`,
      { mode: 0o755 }
    );
    chmodSync(box.deploy, 0o755);

    expect(await run(box, WANT)).toBe(0);

    expect(read(join(box.volume, 'deploy-history'))).toContain(`OK ${WANT} — ${REPORT}`);
  });

  test('a report left by an earlier deploy is never credited to this one', async () => {
    const box = sandbox('stale-park-report');
    writeDockerStub(box.bin, WANT, WANT);
    writeFileSync(join(box.volume, 'deploy-park-report'), `${REPORT}\n`);
    writeSucceedingDeploy(box.deploy);

    expect(await run(box, WANT)).toBe(0);

    const history = read(join(box.volume, 'deploy-history'));
    expect(history).toContain(`OK ${WANT}`);
    expect(history).not.toContain('parked');
  });
});

describePosix('a deploy that is stopped rather than finished', () => {
  test('being killed mid-flight still records what the box is running', async () => {
    const box = sandbox('killed');
    writeDockerStub(box.bin, WANT, WANT);
    writeHangingDeploy(box.deploy);

    const proc = spawnRun(box, WANT);
    await waitForLog(box, 'starting deploy');
    proc.kill('SIGTERM');
    await proc.exited;

    const log = read(join(box.volume, 'deploy-last.log'));
    expect(log).toContain('STOPPED MID-FLIGHT');
    expect(read(join(box.volume, 'deploy-history'))).toContain(`KILLED ${WANT}`);
  });

  test('the recorded verdict names the commit actually live, not the one asked for', async () => {
    const box = sandbox('killed-before-swap');
    writeDockerStub(box.bin, WANT, OTHER);
    writeHangingDeploy(box.deploy);

    const proc = spawnRun(box, WANT);
    await waitForLog(box, 'starting deploy');
    proc.kill('SIGTERM');
    await proc.exited;

    expect(read(join(box.volume, 'deploy-history'))).toContain(`running ${OTHER}`);
  });
});

describePosix('a checkout that moved is still refused', () => {
  test('deploying the difference is worse than deploying nothing', async () => {
    const box = sandbox('moved');
    writeDockerStub(box.bin, OTHER, OTHER);
    writeSucceedingDeploy(box.deploy);

    expect(await run(box, WANT)).toBe(1);

    const log = read(join(box.volume, 'deploy-last.log'));
    expect(log).toContain(`asked for ${WANT}`);
    expect(log).toContain(`checkout is at ${OTHER}`);
  });
});

// ---------------------------------------------------------------------------
// Where the data volume is (#6)
//
// The path used to be a hardcoded default naming one install's docker volume,
// under one compose project name. These cover the two halves of removing it:
// the script can find the volume on a box whose project is called anything,
// and it refuses loudly rather than guessing when it cannot.
// ---------------------------------------------------------------------------

/**
 * A stub `docker` that answers as a differently-named compose project would:
 * `compose ps -aq` yields a container id, and `inspect` reports that
 * container's `/.archon` mount living at `mountpoint`.
 */
function writeDiscoveryDockerStub(bin: string, mountpoint: string | null): void {
  const stub = join(bin, 'docker');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
case "$1 $2" in
  'compose --project-directory')
    for arg in "$@"; do [ "$arg" = '-aq' ] && { ${
      mountpoint === null ? 'exit 0' : "printf 'container-abc\\\\n'; exit 0"
    }; }; done
    exit 0 ;;
  'inspect --format')
    printf '%s\\n' '${mountpoint ?? ''}'; exit 0 ;;
esac
for arg in "$@"; do
  case "$arg" in
    *"rev-parse HEAD"*) printf '%s\\n' '${WANT}'; exit 0 ;;
    *".deployed-sha"*) printf '%s\\n' '${WANT}'; exit 0 ;;
  esac
done
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(stub, 0o755);
}

/** Run with VOLUME deliberately unset, so discovery is what is under test. */
function runDiscovering(box: Sandbox, request: string): Promise<number> {
  writeFileSync(join(box.volume, 'deploy-request'), `${request}\n`);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${box.bin}:${process.env.PATH ?? ''}`,
    DEPLOY: box.deploy,
    DEPLOY_DIR: box.deployDir,
    SOURCE_DIR: '/source',
    SERVICE: 'app',
  };
  delete env.VOLUME;
  return Bun.spawn(['bash', SCRIPT], { env, stdout: 'pipe', stderr: 'pipe' }).exited;
}

describePosix('the data volume is discovered, not assumed', () => {
  test('finds it through the service, whatever the compose project is called', async () => {
    const box = sandbox('discover');
    writeDiscoveryDockerStub(box.bin, box.volume);
    writeSucceedingDeploy(box.deploy);

    await runDiscovering(box, WANT);

    // Proof it found the right directory: the run's artifacts landed in it.
    expect(existsSync(join(box.volume, 'deploy-history'))).toBe(true);
    expect(read(join(box.volume, 'deploy-history'))).toContain(WANT);
    // And the request it consumed was the one in that directory.
    expect(existsSync(join(box.volume, 'deploy-request'))).toBe(false);
  });

  test('refuses loudly when it cannot find the volume, rather than guessing', async () => {
    const box = sandbox('undiscoverable');
    writeDiscoveryDockerStub(box.bin, null);
    writeSucceedingDeploy(box.deploy);
    writeFileSync(join(box.volume, 'deploy-request'), `${WANT}\n`);

    const proc = Bun.spawn(['bash', SCRIPT], {
      env: (() => {
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          PATH: `${box.bin}:${process.env.PATH ?? ''}`,
          DEPLOY: box.deploy,
          DEPLOY_DIR: box.deployDir,
          SOURCE_DIR: '/source',
          SERVICE: 'app',
        };
        delete env.VOLUME;
        return env;
      })(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(code).not.toBe(0);
    expect(stderr).toContain('cannot locate the Archon data volume');
    // Nothing was deployed, and no history was invented somewhere arbitrary.
    expect(existsSync(join(box.volume, 'deploy-history'))).toBe(false);
  });

  test('an explicit VOLUME still wins, because the unit passes one', async () => {
    const box = sandbox('explicit');
    // Discovery would answer with a directory that does not exist; the
    // explicit value must be used instead of it.
    writeDiscoveryDockerStub(box.bin, join(box.deployDir, 'nowhere'));
    writeSucceedingDeploy(box.deploy);

    await run(box, WANT);

    expect(read(join(box.volume, 'deploy-history'))).toContain(WANT);
  });
});

// ---------------------------------------------------------------------------
// The unit pair states one machine-specific path, and states it once.
//
// `PathExists` and `Environment=VOLUME=` are two declarations that must agree:
// the unit reacts to a file, and the service is told which directory that file
// is in. Kept in agreement by this test rather than by remembering.
// ---------------------------------------------------------------------------
describePosix('the systemd units agree about where the volume is', () => {
  const unitDir = join(import.meta.dir, 'deploy-units');

  test('Environment=VOLUME is the directory PathExists watches', () => {
    const pathUnit = read(join(unitDir, 'archon-deploy.path'));
    const serviceUnit = read(join(unitDir, 'archon-deploy.service'));

    const watched = /^PathExists=(.+)$/m.exec(pathUnit)?.[1]?.trim();
    const passed = /^Environment=VOLUME=(.+)$/m.exec(serviceUnit)?.[1]?.trim();

    expect(watched).toBeDefined();
    expect(passed).toBeDefined();
    expect(watched).toBe(`${passed ?? ''}/deploy-request`);
  });
});

/**
 * A docker stub for a box whose sessions work in worktrees: the main checkout
 * is at `mainHead`, and `git worktree list --porcelain` names the others.
 * `git -C '<path>' rev-parse HEAD` answers for the path it is asked about.
 */
function writeWorktreeDockerStub(
  bin: string,
  mainHead: string,
  worktrees: { path: string; sha: string }[]
): void {
  const porcelain = [
    'worktree /source',
    `HEAD ${mainHead}`,
    'detached',
    '',
    ...worktrees.flatMap(w => [`worktree ${w.path}`, `HEAD ${w.sha}`, 'branch refs/heads/x', '']),
  ].join('\\n');
  const perPath = worktrees
    .map(w => `    *"git -C '${w.path}' rev-parse HEAD"*) printf '%s\\n' '${w.sha}'; exit 0 ;;`)
    .join('\n');
  const stub = join(bin, 'docker');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *"worktree list --porcelain"*) printf '${porcelain}\\n'; exit 0 ;;
${perPath}
    *"rev-parse HEAD"*) printf '%s\\n' '${mainHead}'; exit 0 ;;
    *".deployed-sha"*) printf '%s\\n' '${WANT}'; exit 0 ;;
  esac
done
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(stub, 0o755);
}

/** A deploy that records which checkout it was pointed at. */
function writeSourceRecordingDeploy(path: string): void {
  writeFileSync(
    path,
    '#!/usr/bin/env bash\necho "deploying from SOURCE_DIR=$SOURCE_DIR"\nexit 0\n',
    {
      mode: 0o755,
    }
  );
  chmodSync(path, 0o755);
}

describePosix('a request made from a worktree', () => {
  test('deploys from the worktree that holds the requested commit', async () => {
    const box = sandbox('worktree');
    writeWorktreeDockerStub(box.bin, OTHER, [{ path: '/home/appuser/wt-deploy-merge', sha: WANT }]);
    writeSourceRecordingDeploy(box.deploy);

    expect(await run(box, WANT)).toBe(0);

    const log = read(join(box.volume, 'deploy-last.log'));
    expect(log).toContain('deploying from there');
    expect(log).toContain('SOURCE_DIR=/home/appuser/wt-deploy-merge');
    expect(read(join(box.volume, 'deploy-history'))).toContain(`OK ${WANT}`);
  });

  test('still refuses when no checkout holds the requested commit', async () => {
    const box = sandbox('nowhere');
    writeWorktreeDockerStub(box.bin, OTHER, [{ path: '/home/appuser/wt-other', sha: OTHER }]);
    writeSourceRecordingDeploy(box.deploy);

    expect(await run(box, WANT)).toBe(1);

    const log = read(join(box.volume, 'deploy-last.log'));
    expect(log).toContain('no worktree has it');
    expect(log).not.toContain('SOURCE_DIR=');
  });

  test('refuses a worktree path that is not a plain absolute path', async () => {
    const box = sandbox('odd-path');
    writeWorktreeDockerStub(box.bin, OTHER, [{ path: "/home/appuser/wt x'; true", sha: WANT }]);
    writeSourceRecordingDeploy(box.deploy);

    expect(await run(box, WANT)).toBe(1);
    expect(read(join(box.volume, 'deploy-last.log'))).not.toContain('SOURCE_DIR=');
  });
});
