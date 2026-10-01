/**
 * The one reader of a run's artifact directory.
 *
 * Two surfaces list a run's artifacts: the run's own Artifacts tab
 * (`GET /api/runs/{runId}/artifacts`) and the project-wide index on Overview
 * (`GET /api/codebases/{id}/artifacts`, #351). They must agree on where a run's
 * output lives and on which entries count, so both read through here.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getRunArtifactsDirForRoot,
  isRunArtifactsEngineEntry,
  resolveRunStorageRoot,
} from '@archon/paths';

/** One file a run wrote, relative to its artifact directory. */
export interface RunArtifactFile {
  path: string;
  size: number;
  modifiedAt: string;
}

/**
 * Resolve the on-disk artifact directory for a run, for EVERY project kind
 * (#2200).
 *
 * Both artifact routes previously did `parseOwnerRepo(codebase.name)` alone,
 * which returns null for a folder project (display name, no slash) and for a
 * no-remote local repo (bare basename) — so artifact browsing was silently dead
 * for two of the three project kinds Archon can register.
 *
 * The shared root resolver owns trusted persisted-root precedence and
 * relocation fallback; this only composes the artifact directory.
 */
export function resolveRunArtifactDir(
  run: { output_root?: string | null },
  codebase: { kind?: string | null; name: string; default_cwd: string } | null,
  runId: string
): string | null {
  const root = resolveRunStorageRoot(run, codebase);
  return root ? getRunArtifactsDirForRoot(root, runId) : null;
}

/**
 * Every file under a run's artifact directory, sorted by path. A directory that
 * does not exist reads as empty — the run wrote nothing. The engine's own
 * `.archon` child is left out by the rule the CLI's listing shares; a
 * workflow's own dotfiles are its output and stay listed.
 */
export async function listRunArtifactFiles(artifactDir: string): Promise<RunArtifactFile[]> {
  const files: RunArtifactFile[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (isRunArtifactsEngineEntry(rel, entry.name)) continue;
      const child = join(dir, entry.name);
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child, childRel);
      } else if (entry.isFile()) {
        try {
          const s = await stat(child);
          files.push({ path: childRel, size: s.size, modifiedAt: s.mtime.toISOString() });
        } catch (err) {
          // Race with deletion / permission flips: skip ENOENT / EACCES
          // silently, surface anything else so we don't return a half-list
          // with no diagnostic.
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'EACCES') continue;
          throw err;
        }
      }
    }
  }

  await walk(artifactDir, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
