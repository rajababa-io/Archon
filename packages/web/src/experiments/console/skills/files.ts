import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';
import { joinPath, parentPath, toFileEntry, type FileEntry } from '../primitives/file-entry';

interface RawListing {
  path: string;
  entries: { name: string; kind: string; size: number | null }[];
}

interface RawFile {
  path: string;
  content: string;
  size: number;
  etag: string;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  /** Version token to hand back on save. See writeFileContent. */
  etag: string;
}

export interface FileWriteResult {
  path: string;
  size: number;
  etag: string;
}

/**
 * One directory of a project's checkout. `path` is relative to the project
 * root; the empty string is the root itself.
 */
export async function listFiles(projectId: string, path: string): Promise<FileEntry[]> {
  const res = await requestJson<RawListing>(
    `/api/codebases/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`
  );
  return res.entries.map(entry => toFileEntry(entry, res.path));
}

export type ProjectPaths = components['schemas']['CodebasePathsResponse'];

/**
 * Every file in the project's git checkout that .gitignore does not name,
 * relative to the project root. A 409 means the project is not a checkout.
 */
export async function listProjectPaths(projectId: string): Promise<ProjectPaths> {
  return requestJson<ProjectPaths>(`/api/codebases/${encodeURIComponent(projectId)}/paths`);
}

/** One text file. The server refuses binaries and anything over its size ceiling. */
export async function readFileContent(projectId: string, path: string): Promise<FileContent> {
  return requestJson<RawFile>(
    `/api/codebases/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`
  );
}

/**
 * Save one file, refusing to overwrite work done since it was read.
 *
 * `etag` is the token from the read this edit started from. The server
 * compares it against what is on disk now and answers 409 if they differ, so
 * a run that rewrote the file between the read and the save cannot be
 * silently discarded. The caller must surface that, never retry through it.
 */
export async function writeFileContent(
  projectId: string,
  path: string,
  content: string,
  etag: string
): Promise<FileWriteResult> {
  return requestJson<FileWriteResult>(
    `/api/codebases/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`,
    { method: 'PUT', body: JSON.stringify({ content, etag }) }
  );
}

/**
 * URL for an image's raw bytes. A URL rather than a fetch: the browser loads
 * it as an `<img src>`, and the server refuses anything that is not a raster
 * image on its own allow-list.
 */
export function rawFileUrl(projectId: string, path: string): string {
  return `/api/codebases/${encodeURIComponent(projectId)}/raw?path=${encodeURIComponent(path)}`;
}

/**
 * Where an image a markdown file names is loaded from. A relative source is a
 * file in the repo beside the document, which the browser cannot fetch by that
 * path, so it goes to the raw route; an absolute URL is left alone.
 */
export function repoImageUrl(projectId: string, documentPath: string, src: string): string {
  if (/^[a-z]+:|^\/\//i.test(src)) return src;
  const dir = parentPath(documentPath) ?? '';
  return rawFileUrl(projectId, joinPath(dir, src.replace(/^\.\//, '')));
}
