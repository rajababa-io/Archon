import type { ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronRight, File, Folder } from 'lucide-react';
import * as skill from '../../../skills';
import { useEntity } from '../../../store/cache';
import { K } from '../../../store/keys';
import { formatBytes, parentPath, type FileEntry } from '../../../primitives/file-entry';
import { directoryPath, filePath } from '../../lib/paths';

/**
 * One directory of the project's checkout at a time: folders first, each
 * opening in place, files opening the viewer. The directory is in the URL, so
 * Back walks up the tree the way it came down.
 */
export function FilesTab({ projectId }: { projectId: string }): ReactElement {
  const [params] = useSearchParams();
  const dir = params.get('dir') ?? '';
  const { data: entries, error } = useEntity<FileEntry[]>(K.files(projectId, dir), () =>
    skill.listFiles(projectId, dir)
  );
  const parent = parentPath(dir);
  const sorted = entries === undefined ? undefined : [...entries].sort(byKindThenName);

  return (
    <div className="flex flex-col py-2">
      <p className="truncate px-4 pb-1 font-mono text-small text-text-tertiary">/{dir}</p>
      {parent !== null ? (
        <Link
          to={directoryPath(projectId, parent)}
          className="mobile-row flex items-center gap-3 px-4 text-body text-text-secondary"
        >
          <Folder aria-hidden className="h-4 w-4 shrink-0" />
          ..
        </Link>
      ) : null}
      {error !== undefined ? (
        <p className="mobile-note text-error">Couldn&apos;t list this folder: {error.message}</p>
      ) : sorted === undefined ? (
        <p className="mobile-note">Listing…</p>
      ) : sorted.length === 0 ? (
        <p className="mobile-note">This folder is empty.</p>
      ) : (
        <ul aria-label="Files">
          {sorted.map(entry => (
            <li key={entry.path}>
              <EntryRow projectId={projectId} entry={entry} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function byKindThenName(a: FileEntry, b: FileEntry): number {
  const rank = (e: FileEntry): number => (e.kind === 'dir' ? 0 : 1);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

function EntryRow({ projectId, entry }: { projectId: string; entry: FileEntry }): ReactElement {
  if (entry.kind === 'other') {
    return (
      <span className="mobile-row flex items-center gap-3 px-4 text-body text-text-tertiary">
        <File aria-hidden className="h-4 w-4 shrink-0" />
        <span className="truncate">{entry.name}</span>
      </span>
    );
  }
  const isDir = entry.kind === 'dir';
  return (
    <Link
      to={isDir ? directoryPath(projectId, entry.path) : filePath(projectId, entry.path)}
      className="mobile-row flex items-center gap-3 px-4 text-body text-text-primary"
    >
      {isDir ? (
        <Folder aria-hidden className="h-4 w-4 shrink-0 text-text-secondary" />
      ) : (
        <File aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
      )}
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {isDir ? (
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
      ) : (
        <span className="shrink-0 text-small tabular-nums text-text-tertiary">
          {formatBytes(entry.size)}
        </span>
      )}
    </Link>
  );
}
