/**
 * Uncommitted changes against real git.
 *
 * The Changes panel's whole claim is "this is what git says changed", so the
 * tests run git for real: the `-z` field layouts, the rename pairing between
 * `--name-status` and `--numstat`, and the binary "-" counts are git's
 * behavior, not something a mock could assert.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  BaseBranchNotFoundError,
  MAX_DIFF_LINES,
  countChangesOffBase,
  NotAGitCheckoutError,
  listCheckoutFiles,
  readWorkingChanges,
  readWorkingFileDiff,
  type ChangedFile,
} from './changes';

const trackTempRoot = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.email=t@e.com', '-c', 'user.name=T', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function repo(): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'working-changes-')));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'kept.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(root, 'gone.txt'), 'bye\n');
  writeFileSync(join(root, 'moved.txt'), 'a\nb\nc\nd\ne\nf\ng\nh\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function row(files: ChangedFile[], path: string): ChangedFile {
  const found = files.find(f => f.path === path);
  if (!found) throw new Error(`no row for ${path}: ${JSON.stringify(files)}`);
  return found;
}

describe('readWorkingChanges', () => {
  test('lists modified, deleted, renamed, staged-new and untracked files with counts', async () => {
    const root = repo();
    writeFileSync(join(root, 'kept.txt'), 'one\n2\nthree\nfour\n');
    git(root, 'rm', '-q', 'gone.txt');
    git(root, 'mv', 'moved.txt', 'renamed.txt');
    writeFileSync(join(root, 'staged.txt'), 'x\n');
    git(root, 'add', 'staged.txt');
    writeFileSync(join(root, 'fresh.txt'), 'l1\nl2\nl3');
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(root, 'ignored.txt'), 'nope\n');

    const changes = await readWorkingChanges(root);

    expect(changes.branch).toBe('main');
    expect(changes.head).toMatch(/^[0-9a-f]{40}$/);
    expect(changes.omitted).toBe(0);
    expect(row(changes.files, 'kept.txt')).toMatchObject({
      status: 'modified',
      additions: 2,
      deletions: 1,
    });
    expect(row(changes.files, 'gone.txt')).toMatchObject({
      status: 'deleted',
      additions: 0,
      deletions: 1,
    });
    expect(row(changes.files, 'renamed.txt')).toMatchObject({
      status: 'renamed',
      oldPath: 'moved.txt',
      additions: 0,
      deletions: 0,
    });
    expect(row(changes.files, 'staged.txt')).toMatchObject({ status: 'added', additions: 1 });
    expect(row(changes.files, 'fresh.txt')).toMatchObject({
      status: 'untracked',
      additions: 3,
      deletions: 0,
    });
    expect(changes.files.some(f => f.path === 'ignored.txt')).toBe(false);
  });

  test('a clean checkout has no rows', async () => {
    const changes = await readWorkingChanges(repo());
    expect(changes.files).toEqual([]);
  });

  test('reports from the repository root when given a subdirectory', async () => {
    const root = repo();
    const sub = join(root, 'sub');
    Bun.spawnSync(['mkdir', sub]);
    writeFileSync(join(sub, 'deep.txt'), 'deep\n');
    const changes = await readWorkingChanges(sub);
    expect(changes.files.map(f => f.path)).toEqual(['sub/deep.txt']);
  });

  test('works in a repository with no commit yet', async () => {
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'working-changes-unborn-')));
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', 'a.txt');
    const changes = await readWorkingChanges(root);
    expect(changes.head).toBeNull();
    expect(row(changes.files, 'a.txt')).toMatchObject({ status: 'added', additions: 1 });
  });

  test('refuses a directory that is not a checkout', async () => {
    const plain = trackTempRoot(mkdtempSync(join(tmpdir(), 'working-changes-plain-')));
    await expect(readWorkingChanges(plain)).rejects.toBeInstanceOf(NotAGitCheckoutError);
  });

  test('leaves the index untouched', async () => {
    const root = repo();
    writeFileSync(join(root, 'kept.txt'), 'changed\n');
    const index = join(root, '.git', 'index');
    const before = readFileSync(index);
    const mtime = statSync(index).mtimeMs;
    await readWorkingChanges(root);
    expect(readFileSync(index).equals(before)).toBe(true);
    expect(statSync(index).mtimeMs).toBe(mtime);
  });
});

describe('readWorkingFileDiff', () => {
  test('shows a tracked file diff against HEAD', async () => {
    const root = repo();
    writeFileSync(join(root, 'kept.txt'), 'one\n2\nthree\n');
    const { files } = await readWorkingChanges(root);
    const diff = await readWorkingFileDiff(root, row(files, 'kept.txt'));
    expect(diff.binary).toBe(false);
    expect(diff.truncated).toBe(false);
    expect(diff.patch).toContain('-two');
    expect(diff.patch).toContain('+2');
  });

  test('shows an untracked file as all additions', async () => {
    const root = repo();
    writeFileSync(join(root, 'fresh.txt'), 'l1\nl2');
    const { files } = await readWorkingChanges(root);
    const diff = await readWorkingFileDiff(root, row(files, 'fresh.txt'));
    expect(diff.patch).toContain('@@ -0,0 +1,2 @@\n+l1\n+l2\n\\ No newline at end of file');
  });

  test('shows a rename with both paths', async () => {
    const root = repo();
    git(root, 'mv', 'moved.txt', 'renamed.txt');
    const { files } = await readWorkingChanges(root);
    const diff = await readWorkingFileDiff(root, row(files, 'renamed.txt'));
    expect(diff.patch).toContain('rename from moved.txt');
    expect(diff.patch).toContain('rename to renamed.txt');
  });

  test('marks binary files instead of returning their bytes', async () => {
    const root = repo();
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0]));
    git(root, 'add', 'blob.bin');
    writeFileSync(join(root, 'loose.bin'), Buffer.from([0, 9, 0]));
    const { files } = await readWorkingChanges(root);
    expect(row(files, 'blob.bin').additions).toBeNull();
    expect(await readWorkingFileDiff(root, row(files, 'blob.bin'))).toMatchObject({
      binary: true,
      patch: '',
    });
    expect(await readWorkingFileDiff(root, row(files, 'loose.bin'))).toMatchObject({
      binary: true,
      patch: '',
    });
  });

  test('cuts a long diff and says so', async () => {
    const root = repo();
    const big = Array.from({ length: MAX_DIFF_LINES + 50 }, (_, i) => `line ${String(i)}`).join(
      '\n'
    );
    writeFileSync(join(root, 'kept.txt'), big);
    const { files } = await readWorkingChanges(root);
    const diff = await readWorkingFileDiff(root, row(files, 'kept.txt'));
    expect(diff.truncated).toBe(true);
    expect(diff.patch.split('\n').length).toBeLessThanOrEqual(MAX_DIFF_LINES + 1);
  });
});

describe('listCheckoutFiles', () => {
  test('lists tracked and untracked files, leaving out what .gitignore names', async () => {
    const root = repo();
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\nbuild/\n');
    writeFileSync(join(root, 'ignored.txt'), 'nope\n');
    mkdirSync(join(root, 'build'));
    writeFileSync(join(root, 'build', 'out.js'), 'x\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'fresh.ts'), 'y\n');

    const listed = await listCheckoutFiles(root);

    expect(listed).toEqual({
      paths: ['.gitignore', 'gone.txt', 'kept.txt', 'moved.txt', 'src/fresh.ts'],
      truncated: false,
    });
  });

  test('paths are relative to the directory asked about, not the repository root', async () => {
    const root = repo();
    mkdirSync(join(root, 'pkg'));
    writeFileSync(join(root, 'pkg', 'inner.ts'), 'z\n');
    git(root, 'add', '.');

    expect((await listCheckoutFiles(join(root, 'pkg'))).paths).toEqual(['inner.ts']);
  });

  test('a plain directory is not a checkout', async () => {
    const plain = trackTempRoot(mkdtempSync(join(tmpdir(), 'not-a-checkout-')));
    await expect(listCheckoutFiles(plain)).rejects.toBeInstanceOf(NotAGitCheckoutError);
  });
});

describe('countChangesOffBase', () => {
  /**
   * A checkout on `main` whose base branch `dev` has since moved on: `dev`
   * edited kept.txt twice (v1, then v2), added merged.txt, and deleted gone.txt.
   * The checkout is left where it was, the way a shared live folder is.
   */
  function behindBase(): string {
    const root = repo();
    git(root, 'checkout', '-q', '-b', 'dev');
    writeFileSync(join(root, 'kept.txt'), 'v1\n');
    git(root, 'commit', '-q', '-am', 'v1');
    writeFileSync(join(root, 'kept.txt'), 'v2\n');
    writeFileSync(join(root, 'merged.txt'), 'merged\n');
    git(root, 'rm', '-q', 'gone.txt');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'v2');
    git(root, 'checkout', '-q', 'main');
    return root;
  }

  test('a change whose content is already on the base branch is not counted', async () => {
    const root = behindBase();
    writeFileSync(join(root, 'kept.txt'), 'v2\n');
    writeFileSync(join(root, 'merged.txt'), 'merged\n');
    git(root, 'add', 'merged.txt');
    git(root, 'rm', '-q', 'gone.txt');

    expect(await countChangesOffBase(root, 'dev')).toBe(0);
  });

  test('a new file absent from the base branch is counted', async () => {
    const root = behindBase();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'only-here.ts'), 'new\n');

    expect(await countChangesOffBase(root, 'dev')).toBe(1);
  });

  test('a staged older version of a file the base has since changed is not counted', async () => {
    // Not lost work: v1 is in the base history even though the tip moved to v2.
    const root = behindBase();
    writeFileSync(join(root, 'kept.txt'), 'v1\n');
    git(root, 'add', 'kept.txt');

    expect(await countChangesOffBase(root, 'dev')).toBe(0);
  });

  test('a staged copy of base content with a further working-tree edit is counted', async () => {
    const root = behindBase();
    writeFileSync(join(root, 'kept.txt'), 'v2\n');
    git(root, 'add', 'kept.txt');
    writeFileSync(join(root, 'kept.txt'), 'v3, only here\n');

    expect(await countChangesOffBase(root, 'dev')).toBe(1);
  });

  test('deleting a file the base still has is counted', async () => {
    const root = behindBase();
    git(root, 'rm', '-q', 'moved.txt');

    expect(await countChangesOffBase(root, 'dev')).toBe(1);
  });

  test("content only on a remote's copy of the base branch is not counted", async () => {
    const root = repo();
    const main = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'kept.txt'), 'from the fork\n');
    git(root, 'commit', '-q', '-am', 'fork work');
    git(root, 'update-ref', 'refs/remotes/fork/dev', 'HEAD');
    git(root, 'update-ref', 'refs/heads/dev', main);
    git(root, 'reset', '-q', '--hard', main);
    writeFileSync(join(root, 'kept.txt'), 'from the fork\n');

    expect(await countChangesOffBase(root, 'dev')).toBe(0);
  });

  test('reads without writing the index', async () => {
    const root = behindBase();
    writeFileSync(join(root, 'kept.txt'), 'v2\n');
    writeFileSync(join(root, 'fresh.txt'), 'x\n');
    const index = join(root, '.git', 'index');
    const before = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs };

    expect(await countChangesOffBase(root, 'dev')).toBe(1);
    expect(readFileSync(index).equals(before.bytes)).toBe(true);
    expect(statSync(index).mtimeMs).toBe(before.mtime);
    expect(git(root, 'status', '--porcelain')).toContain('?? fresh.txt');
  });

  test('a base branch with no ref cannot be compared', async () => {
    const root = repo();
    writeFileSync(join(root, 'fresh.txt'), 'x\n');
    await expect(countChangesOffBase(root, 'dev')).rejects.toBeInstanceOf(BaseBranchNotFoundError);
  });

  test('a plain directory is not a checkout', async () => {
    const plain = trackTempRoot(mkdtempSync(join(tmpdir(), 'not-a-checkout-')));
    await expect(countChangesOffBase(plain, 'dev')).rejects.toBeInstanceOf(NotAGitCheckoutError);
  });
});
