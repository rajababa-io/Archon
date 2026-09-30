/**
 * Tests for `scripts/docker-reclaim.sh` — the host-side half of disk reclaim.
 *
 * What is under test is WHICH images it removes. The invariant from #327 is
 * that the image the app runs and the one a rollback needs are never pruned,
 * and a tagged image — which is what a deploy's fresh build is until the swap —
 * is never removed by id.
 *
 * Driven as a SUBPROCESS with `docker`, `systemctl` and `curl` stubbed on PATH.
 * The stub answers from a table of images and records every call, so the
 * assertions read the removals the script asked Docker for.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

/** POSIX only, for the reasons `deploy-on-request.test.ts` gives: a host script, stubs on PATH. */
const describePosix = process.platform === 'win32' ? describe.skip : describe;

const trackTempRoot = trackTempRoots();
const SCRIPT = join(import.meta.dir, 'docker-reclaim.sh');
const LABEL_KEY = 'org.opencontainers.image.source';
const LABEL = 'https://github.com/coleam00/Archon';

const id = (n: string): string => `sha256:${n.repeat(64)}`;
const RUNNING = id('a');

interface Image {
  id: string;
  created: string;
  tags: number;
}

interface Box {
  root: string;
  calls: string;
  ledger: string;
}

function write(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function sandbox(
  images: Image[],
  opts: { label?: string; refuse?: string[]; deployActive?: boolean; builderFails?: boolean } = {}
): Box {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'docker-reclaim-')));
  const bin = join(root, 'bin');
  const volume = join(root, 'volume');
  mkdirSync(bin);
  mkdirSync(volume);
  const calls = join(root, 'calls');
  writeFileSync(calls, '');
  writeFileSync(
    join(root, 'images'),
    images.map(i => `${i.id} ${i.created} ${String(i.tags)}`).join('\n') + '\n'
  );
  const running = images.find(i => i.id === RUNNING);
  const label = opts.label ?? LABEL;

  write(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "docker $*" >>'${calls}'
args="$*"
case "$args" in
  *"ps -q app"*) echo cid1 ;;
  "inspect --format {{.Image}} cid1") echo '${RUNNING}' ;;
  "inspect --format {{range .Mounts}}"*) echo '${volume}' ;;
  "image inspect --format {{index .Config.Labels"*) echo '${label}' ;;
  "image inspect --format {{.Created}} ${RUNNING}") echo '${running?.created ?? ''}' ;;
  "images -q --no-trunc --filter label=${LABEL_KEY}=${LABEL}") cut -d' ' -f1 '${join(root, 'images')}' ;;
  "image inspect --format {{.Id}} {{.Created}} {{len .RepoTags}}"*)
    shift 4; for want in "$@"; do grep "^$want " '${join(root, 'images')}'; done ;;
  rmi*) case " ${(opts.refuse ?? []).join(' ')} " in *" $2 "*) echo "conflict: in use" >&2; exit 1 ;; esac ;;
  "builder prune"*) ${opts.builderFails ? 'echo broken >&2; exit 1' : 'echo "Total: 1GB"'} ;;
esac
exit 0
`
  );
  write(join(bin, 'systemctl'), `#!/usr/bin/env bash\nexit ${opts.deployActive ? 0 : 3}\n`);
  write(join(bin, 'curl'), `#!/usr/bin/env bash\necho "curl $*" >>'${calls}'\n`);
  return { root, calls, ledger: join(volume, 'logs', 'docker-reclaim.log') };
}

function run(box: Box, env: Record<string, string> = {}): { code: number; out: string } {
  const result = Bun.spawnSync(['bash', SCRIPT], {
    env: {
      PATH: `${join(box.root, 'bin')}:${process.env.PATH ?? ''}`,
      DEPLOY_DIR: box.root,
      DOCKER_ROOT: box.root,
      ...env,
    },
  });
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

const callsOf = (box: Box): string[] => readFileSync(box.calls, 'utf8').trim().split('\n');
const removals = (box: Box): string[] =>
  callsOf(box)
    .filter(c => c.startsWith('docker rmi '))
    .map(c => c.slice('docker rmi '.length));

describePosix('docker-reclaim.sh', () => {
  test('keeps the running, rollback, tagged and newer images; removes older untagged ones', () => {
    const box = sandbox([
      { id: RUNNING, created: '2026-09-30T21:00:00.5Z', tags: 1 },
      { id: id('b'), created: '2026-09-30T22:00:00Z', tags: 0 }, // built after, not swapped to
      { id: id('c'), created: '2026-09-29T21:00:00Z', tags: 0 }, // rollback
      { id: id('d'), created: '2026-09-28T21:00:00Z', tags: 1 }, // tagged
      { id: id('e'), created: '2026-09-27T21:00:00Z', tags: 0 },
      { id: id('f'), created: '2026-09-26T21:00:00Z', tags: 0 },
    ]);
    const { code, out } = run(box);

    expect(code).toBe(0);
    expect(removals(box)).toEqual([id('e'), id('f')]);
    expect(out).toContain(`keep ${id('c')} — rollback image`);
    expect(callsOf(box)).toContain(`docker image prune -f --filter label!=${LABEL_KEY}=${LABEL}`);
    expect(callsOf(box)).toContain('docker builder prune -f --filter until=168h');
    expect(readFileSync(box.ledger, 'utf8')).toMatch(/ OK freed=-?\d+ removed=2 kept=a{12},c{12}/);
  });

  test('removes no app image when the running image carries no label', () => {
    const box = sandbox(
      [
        { id: RUNNING, created: '2026-09-30T21:00:00Z', tags: 1 },
        { id: id('e'), created: '2026-09-27T21:00:00Z', tags: 0 },
      ],
      { label: '' }
    );
    const { code } = run(box);

    expect(code).toBe(0);
    expect(removals(box)).toEqual([]);
    expect(callsOf(box).some(c => c.startsWith('docker image prune'))).toBe(false);
    expect(callsOf(box)).toContain('docker builder prune -f --filter until=168h');
  });

  test('does nothing while a deploy is running', () => {
    const box = sandbox([{ id: RUNNING, created: '2026-09-30T21:00:00Z', tags: 1 }], {
      deployActive: true,
    });
    const { code } = run(box);

    expect(code).toBe(0);
    expect(callsOf(box).some(c => / (rmi|prune) /.test(c))).toBe(false);
    expect(readFileSync(box.ledger, 'utf8')).toContain('skipped=deploy-running');
  });

  test('an image docker refuses to remove is kept, not a failure', () => {
    const box = sandbox(
      [
        { id: RUNNING, created: '2026-09-30T21:00:00Z', tags: 1 },
        { id: id('c'), created: '2026-09-29T21:00:00Z', tags: 0 },
        { id: id('e'), created: '2026-09-27T21:00:00Z', tags: 0 },
      ],
      { refuse: [id('e')] }
    );
    const { code, out } = run(box);

    expect(code).toBe(0);
    expect(out).toContain(`kept ${id('e')} — docker refused`);
  });

  test('pings Healthchecks, and pings /fail when a prune fails', () => {
    const images = [{ id: RUNNING, created: '2026-09-30T21:00:00Z', tags: 1 }];
    const ok = sandbox(images);
    expect(run(ok, { HC_PING_URL: 'https://hc.example/ping/x/' }).code).toBe(0);
    expect(
      callsOf(ok)
        .filter(c => c.startsWith('curl'))
        .join()
    ).toContain('https://hc.example/ping/x');

    const broken = sandbox(images, { builderFails: true });
    expect(run(broken, { HC_PING_URL: 'https://hc.example/ping/x' }).code).toBe(1);
    expect(
      callsOf(broken)
        .filter(c => c.startsWith('curl'))
        .join()
    ).toContain('https://hc.example/ping/x/fail');
    expect(readFileSync(broken.ledger, 'utf8')).toContain(' FAILED ');
  });
});
