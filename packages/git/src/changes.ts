import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { execFileAsync } from './exec';

/**
 * The uncommitted changes in one checkout, and the files it holds, read
 * without touching it.
 *
 * "Uncommitted" means the working tree and the index against HEAD, plus
 * untracked files that are not ignored — everything `git status` would show,
 * which is what an agent's edits look like before anything commits them.
 * Committed work is not here: which base a branch should be compared with is a
 * judgement (dev? main? the fork point?), and this module does not guess it.
 *
 * READ-ONLY by construction: every git call runs with `--no-optional-locks`,
 * so not even the index stat-refresh that `git status` normally writes back is
 * performed. The caller is a viewer, and a viewer that took `index.lock` could
 * fail an agent's own `git add` mid-turn.
 */

/** Git's well-known empty tree — the base for a repository with no commit yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Rows listed before the rest are counted but not named. */
export const MAX_CHANGED_FILES = 500;
/** Diff lines returned for one file before it is cut, with a note saying so. */
export const MAX_DIFF_LINES = 4000;
/** An untracked file larger than this is listed but not counted or shown. */
const MAX_UNTRACKED_BYTES = 1024 * 1024;
/** Output ceiling for one git call. Past it the call fails and is reported as too large. */
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'other';

export interface ChangedFile {
  /** Path relative to the repository root, after any rename. */
  path: string;
  /** The path before a rename; null for every other status. */
  oldPath: string | null;
  status: ChangeStatus;
  /** Lines added and removed; null for a binary or oversized file. */
  additions: number | null;
  deletions: number | null;
}

export interface WorkingChanges {
  /** The repository root the paths are relative to. */
  root: string;
  /** Checked-out branch, or null when HEAD is detached or unborn. */
  branch: string | null;
  /** HEAD commit, or null in a repository with no commit yet. */
  head: string | null;
  files: ChangedFile[];
  /** How many changed files exist beyond `files` — listed as a count, not by name. */
  omitted: number;
}

export interface FileDiff {
  path: string;
  /** Unified diff text, possibly cut at MAX_DIFF_LINES. Empty for a binary file. */
  patch: string;
  binary: boolean;
  /** True when `patch` is not the whole diff. */
  truncated: boolean;
}

/** Why a directory has no changes to read. */
export class NotAGitCheckoutError extends Error {
  constructor(readonly path: string) {
    super(`Not a git checkout: ${path}`);
    this.name = 'NotAGitCheckoutError';
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-C', cwd, ...args], {
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: 30_000,
  });
  return stdout;
}

/** Resolve the repository root and HEAD, or throw NotAGitCheckoutError. */
async function repoState(
  cwd: string
): Promise<{ root: string; head: string | null; branch: string | null }> {
  let root: string;
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    // rev-parse fails for a missing directory and for a plain one alike; both
    // mean there is no checkout here to show changes for.
    throw new NotAGitCheckoutError(cwd);
  }
  // `--verify -q` exits non-zero without a message when HEAD is unborn.
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(
    out => out.trim() || null,
    () => null
  );
  const branch = await git(root, ['symbolic-ref', '-q', '--short', 'HEAD']).then(
    out => out.trim() || null,
    () => null
  );
  return { root, head, branch };
}

/** Split `-z` output into its NUL-separated fields, dropping the trailing empty one. */
function nulFields(out: string): string[] {
  const fields = out.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

function statusFromLetter(letter: string): ChangeStatus {
  switch (letter[0]) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'other';
  }
}

/**
 * Tracked changes: `--name-status` for what happened to each path, `--numstat`
 * for how many lines. Two calls because neither format carries both, and both
 * list the same paths in the same order under the same `-M`.
 */
async function trackedChanges(root: string, base: string): Promise<ChangedFile[]> {
  const [nameStatus, numstat] = await Promise.all([
    git(root, ['diff', '--name-status', '-z', '-M', base]),
    git(root, ['diff', '--numstat', '-z', '-M', base]),
  ]);

  const files: ChangedFile[] = [];
  const statusFields = nulFields(nameStatus);
  for (let i = 0; i < statusFields.length; ) {
    const letter = statusFields[i++] ?? '';
    if (letter.startsWith('R') || letter.startsWith('C')) {
      const oldPath = statusFields[i++] ?? '';
      const path = statusFields[i++] ?? '';
      files.push({
        path,
        oldPath,
        status: statusFromLetter(letter),
        additions: null,
        deletions: null,
      });
    } else {
      const path = statusFields[i++] ?? '';
      files.push({
        path,
        oldPath: null,
        status: statusFromLetter(letter),
        additions: null,
        deletions: null,
      });
    }
  }

  // numstat -z: "add\tdel\tpath\0", or for a rename "add\tdel\t\0old\0new\0".
  // Binary files report "-" for both counts, which stays null.
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  const numFields = nulFields(numstat);
  for (let i = 0; i < numFields.length; ) {
    const [add = '-', del = '-', inlinePath = ''] = (numFields[i++] ?? '').split('\t');
    let path = inlinePath;
    if (path === '') {
      i++; // old path
      path = numFields[i++] ?? '';
    }
    counts.set(path, {
      additions: add === '-' ? null : Number(add),
      deletions: del === '-' ? null : Number(del),
    });
  }
  for (const file of files) {
    const c = counts.get(file.path);
    if (c) {
      file.additions = c.additions;
      file.deletions = c.deletions;
    }
  }
  return files;
}

/** Read an untracked file for display, or say why it cannot be shown. */
async function readUntracked(
  root: string,
  path: string
): Promise<{ kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'too-large' }> {
  const full = join(root, path);
  const info = await stat(full);
  if (!info.isFile()) return { kind: 'binary' };
  if (info.size > MAX_UNTRACKED_BYTES) return { kind: 'too-large' };
  const buffer = await readFile(full);
  // A NUL byte is git's own binary heuristic, and the byte that would corrupt a JSON body.
  if (buffer.includes(0)) return { kind: 'binary' };
  return { kind: 'text', text: buffer.toString('utf-8') };
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

async function untrackedChanges(root: string): Promise<ChangedFile[]> {
  const out = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return Promise.all(
    nulFields(out).map(async (path): Promise<ChangedFile> => {
      let additions: number | null = null;
      try {
        const read = await readUntracked(root, path);
        if (read.kind === 'text') additions = lineCount(read.text);
      } catch {
        // Vanished between the listing and the read — an agent mid-edit. The
        // row stays, uncounted, rather than failing the whole listing.
      }
      return {
        path,
        oldPath: null,
        status: 'untracked',
        additions,
        deletions: additions === null ? null : 0,
      };
    })
  );
}

/** List every uncommitted change in the checkout at `cwd`. */
export async function readWorkingChanges(cwd: string): Promise<WorkingChanges> {
  const { root, head, branch } = await repoState(cwd);
  const [tracked, untracked] = await Promise.all([
    trackedChanges(root, head ?? EMPTY_TREE),
    untrackedChanges(root),
  ]);
  const all = [...tracked, ...untracked].sort((a, b) => a.path.localeCompare(b.path));
  return {
    root,
    branch,
    head,
    files: all.slice(0, MAX_CHANGED_FILES),
    omitted: Math.max(0, all.length - MAX_CHANGED_FILES),
  };
}

function cutPatch(patch: string): { patch: string; truncated: boolean } {
  const lines = patch.split('\n');
  if (lines.length <= MAX_DIFF_LINES) return { patch, truncated: false };
  return { patch: lines.slice(0, MAX_DIFF_LINES).join('\n') + '\n', truncated: true };
}

function untrackedPatch(path: string, text: string): string {
  const count = lineCount(text);
  const body = text
    .split('\n')
    .slice(0, count)
    .map(line => `+${line}`)
    .join('\n');
  const noEol = text !== '' && !text.endsWith('\n') ? '\n\\ No newline at end of file' : '';
  return (
    `diff --git a/${path} b/${path}\nnew file\n--- /dev/null\n+++ b/${path}\n` +
    (count > 0 ? `@@ -0,0 +1,${String(count)} @@\n${body}${noEol}\n` : '')
  );
}

/**
 * The diff of one changed file.
 *
 * Takes the ChangedFile row rather than a bare path on purpose: the caller
 * must have found the path in `readWorkingChanges` first, so this can only
 * ever show a file git itself reported as changed — never an arbitrary path
 * a request named.
 */
export async function readWorkingFileDiff(cwd: string, file: ChangedFile): Promise<FileDiff> {
  const { root, head } = await repoState(cwd);

  if (file.status === 'untracked') {
    const read = await readUntracked(root, file.path);
    if (read.kind === 'binary')
      return { path: file.path, patch: '', binary: true, truncated: false };
    if (read.kind === 'too-large')
      return { path: file.path, patch: '', binary: false, truncated: true };
    return { path: file.path, binary: false, ...cutPatch(untrackedPatch(file.path, read.text)) };
  }

  // numstat reports "-" for a binary file's counts, so a tracked row with no
  // counts is binary — decided from git's structured output, not its prose.
  if (file.additions === null) {
    return { path: file.path, patch: '', binary: true, truncated: false };
  }

  const paths = file.oldPath !== null ? [file.oldPath, file.path] : [file.path];
  let patch: string;
  try {
    patch = await git(root, ['diff', '-M', head ?? EMPTY_TREE, '--', ...paths]);
  } catch (error) {
    // Past MAX_GIT_OUTPUT the diff is refused rather than read whole: showing a
    // note beats freezing the panel on a generated file.
    if ((error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { path: file.path, patch: '', binary: false, truncated: true };
    }
    throw error;
  }
  return { path: file.path, binary: false, ...cutPatch(patch) };
}

/** Paths `listCheckoutFiles` returns before it stops and says so. */
export const MAX_LISTED_FILES = 20_000;

export interface CheckoutFiles {
  /** Paths relative to the directory asked about, forward slashes, sorted. */
  paths: string[];
  /** True when the checkout holds more than MAX_LISTED_FILES and the rest were left out. */
  truncated: boolean;
}

/**
 * Every file in the checkout at `cwd` — tracked, plus untracked files that are
 * not ignored — relative to `cwd`.
 *
 * Git's own listing rather than a directory walk: it is what keeps
 * `node_modules`, build output and everything else `.gitignore` names out of
 * the list, which a walk would have to reinvent and would get wrong.
 */
export async function listCheckoutFiles(cwd: string): Promise<CheckoutFiles> {
  await repoState(cwd);
  const out = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  // A conflicted file is listed once per stage; the set keeps one.
  const all = [...new Set(out.split('\0').filter(p => p.length > 0))].sort();
  return {
    paths: all.slice(0, MAX_LISTED_FILES),
    truncated: all.length > MAX_LISTED_FILES,
  };
}

/** No base branch ref exists in the checkout, so nothing can be compared with it. */
export class BaseBranchNotFoundError extends Error {
  constructor(readonly baseBranch: string) {
    super(`No ref for base branch '${baseBranch}'`);
    this.name = 'BaseBranchNotFoundError';
  }
}

/** One content a changed path holds: a blob id, or null for "the path is gone". */
type HeldVersion = string | null;

interface HeldPath {
  path: string;
  /** The contents this path holds that HEAD does not. */
  versions: HeldVersion[];
  /** True when the working-tree file must be hashed to know its content. */
  hashWorktree: boolean;
  /** Counted without comparing: a conflict or a submodule. */
  alwaysCounted: boolean;
}

/**
 * Parse `git status --porcelain=v2 -z --untracked-files=all` into the content
 * each changed path holds that HEAD does not.
 *
 * A path can hold two such contents — a staged one and a different one in the
 * working tree — and a reset destroys both, so both are compared. A content
 * equal to HEAD's is already committed and is left out.
 */
function heldPaths(status: string): HeldPath[] {
  const held: HeldPath[] = [];
  const fields = nulFields(status);
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? '';
    const kind = entry[0];
    if (kind === '?') {
      held.push({ path: entry.slice(2), versions: [], hashWorktree: true, alwaysCounted: false });
      continue;
    }
    if (kind === 'u') {
      // `u XY sub m1 m2 m3 mW h1 h2 h3 path` — a conflict is unfinished work.
      const path = entry.split(' ').slice(10).join(' ');
      held.push({ path, versions: [], hashWorktree: false, alwaysCounted: true });
      continue;
    }
    if (kind !== '1' && kind !== '2') continue;
    // `1 XY sub mH mI mW hH hI path`; `2` adds a score before the path and its
    // original path in the next NUL field. The original's content is at HEAD,
    // so a rename's source is never lost work.
    const parts = entry.split(' ');
    const [, xy = '..', sub = 'N...', , , , hH = '', hI = ''] = parts;
    const path = parts.slice(kind === '1' ? 8 : 9).join(' ');
    if (kind === '2') i++;
    const [staged = '.', worktree = '.'] = xy;
    const versions: HeldVersion[] = [];
    if (staged !== '.') versions.push(staged === 'D' ? null : hI);
    if (worktree === 'D') versions.push(null);
    held.push({
      path,
      versions: versions.filter(v => v !== hH),
      hashWorktree: worktree !== '.' && worktree !== 'D',
      alwaysCounted: sub !== 'N...',
    });
  }
  return held;
}

/**
 * How many changed paths in the checkout at `cwd` hold content that is not
 * already on `baseBranch` — the uncommitted work a reset would actually lose.
 *
 * `git status` alone cannot say that: a checkout shared by several chats
 * nearly always holds leftover copies of work that has since merged, and a
 * warning lit for those is one nobody reads. Here each content a changed path
 * holds (staged, working tree, or deleted) is compared with the base branch:
 *
 * - it matches when a base ref's tip holds exactly that blob at that path, or
 *   any commit in the base history did — an older version the base has since
 *   moved past is still recoverable from it, so it is not lost;
 * - a deletion matches when some base tip no longer has the path.
 *
 * "The base branch" is every ref that names it: the local branch and each
 * remote's copy (`refs/remotes/<any>/<base>`). A checkout with several
 * remotes cannot say which one is canonical, and content on any of them
 * exists outside this folder. Nothing is fetched — refs are as fresh as the
 * last fetch, and staleness can only over-count, never hide work.
 *
 * A conflict or a submodule change is counted without comparing. Past
 * MAX_CHANGED_FILES the remainder is counted unchecked rather than hashed.
 * READ-ONLY: `--no-optional-locks` on every call, and `hash-object` without
 * `-w` writes nothing.
 *
 * Throws NotAGitCheckoutError, BaseBranchNotFoundError, or the git failure —
 * the caller decides what an unanswered comparison shows, and it is not clean.
 */
export async function countChangesOffBase(cwd: string, baseBranch: string): Promise<number> {
  const { root } = await repoState(cwd);
  const refs = (
    await git(root, [
      'for-each-ref',
      '--format=%(refname)',
      `refs/heads/${baseBranch}`,
      `refs/remotes/*/${baseBranch}`,
    ])
  )
    .split('\n')
    .filter(ref => ref.length > 0);
  if (refs.length === 0) throw new BaseBranchNotFoundError(baseBranch);

  const all = heldPaths(
    await git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  );
  const checked = all.slice(0, MAX_CHANGED_FILES);
  const toCompare = checked.filter(p => !p.alwaysCounted);
  const counted = all.length - toCompare.length;

  // One blob id per line, in argument order.
  const toHash = toCompare.filter(p => p.hashWorktree);
  if (toHash.length > 0) {
    const ids = (await git(root, ['hash-object', '--', ...toHash.map(p => p.path)])).split('\n');
    toHash.forEach((p, n) => p.versions.push(ids[n] ?? ''));
  }

  const pending = toCompare.filter(p => p.versions.length > 0);
  if (pending.length === 0) return counted;

  // Tip contents, per ref: `mode type blob\tpath`.
  const atTip = new Set<string>();
  const tipsHolding = new Map<string, number>();
  for (const ref of refs) {
    const listing = await git(root, [
      '--literal-pathspecs',
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      ref,
      '--',
      ...pending.map(p => p.path),
    ]);
    for (const line of nulFields(listing)) {
      const tab = line.indexOf('\t');
      const path = line.slice(tab + 1);
      atTip.add(`${path}\0${line.slice(0, tab).split(' ')[2] ?? ''}`);
      tipsHolding.set(path, (tipsHolding.get(path) ?? 0) + 1);
    }
  }
  const onTip = (path: string, v: HeldVersion): boolean =>
    v === null ? (tipsHolding.get(path) ?? 0) < refs.length : atTip.has(`${path}\0${v}`);
  const offTip = pending.filter(p => !p.versions.every(v => onTip(p.path, v)));
  if (offTip.length === 0) return counted;

  // Every blob each remaining path has held anywhere in the base history.
  // `--raw -z` gives `:modeA modeB blobA blobB S\0path\0` per change.
  const inHistory = new Set<string>();
  const log = await git(root, [
    '--literal-pathspecs',
    'log',
    '--raw',
    '-z',
    '--no-abbrev',
    '--no-renames',
    '--format=',
    ...refs,
    '--',
    ...offTip.map(p => p.path),
  ]);
  const fields = nulFields(log);
  for (let i = 0; i + 1 < fields.length; i++) {
    const meta = (fields[i] ?? '').trimStart();
    if (!meta.startsWith(':')) continue;
    const [, , blobA = '', blobB = ''] = meta.split(' ');
    const path = fields[++i] ?? '';
    inHistory.add(`${path}\0${blobA}`);
    inHistory.add(`${path}\0${blobB}`);
  }
  const lost = offTip.filter(
    p =>
      !p.versions.every(v => onTip(p.path, v) || (v !== null && inHistory.has(`${p.path}\0${v}`)))
  );
  return counted + lost.length;
}
