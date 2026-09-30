import { useMemo, useState, type ReactElement } from 'react';
import * as skill from '../../skills';
import { useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { errorDetail } from '../../lib/http';
import { rankPaths } from '../lib/fuzzy-path';
import { Sheet, SheetRow } from './Sheet';

/** Rows shown for one search; the box narrows past this, it does not scroll. */
const SHOWN = 50;

interface FileSheetProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Put `@path` in the composer. */
  onPick: (path: string) => void;
}

/** `@` — find a file in the project by a few letters of its name. */
export function FileSheet({ open, onClose, projectId, onPick }: FileSheetProps): ReactElement {
  return (
    <Sheet title="Mention a file" open={open} onClose={onClose} tall>
      {open ? <FileSearch projectId={projectId} onPick={onPick} /> : null}
    </Sheet>
  );
}

function FileSearch({
  projectId,
  onPick,
}: Pick<FileSheetProps, 'projectId' | 'onPick'>): ReactElement {
  const { data, error } = useEntity(K.projectPaths(projectId), () =>
    skill.listProjectPaths(projectId)
  );
  const [query, setQuery] = useState('');
  const found = useMemo(() => rankPaths(data?.paths ?? [], query, SHOWN), [data, query]);

  const status = ((): string | null => {
    if (error !== undefined) return null;
    if (data === undefined) return 'Loading the file list…';
    if (query.trim() === '') {
      return `Type part of a file name to search ${data.paths.length.toLocaleString()} files.`;
    }
    if (found.length === 0) {
      return data.truncated
        ? 'No match in the files searched — this project has more than could be listed.'
        : 'No file matches.';
    }
    return null;
  })();

  return (
    <>
      <div className="shrink-0 px-4 pb-2">
        <input
          type="search"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
          }}
          placeholder="File name"
          aria-label="Search files"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="min-h-11 w-full rounded-lg border border-border bg-surface-inset px-3 mobile-input text-text-primary outline-none placeholder:text-text-tertiary"
        />
      </div>
      {error !== undefined ? (
        <p role="alert" className="mobile-note text-error">
          {errorDetail(error)}
        </p>
      ) : null}
      {status !== null ? <p className="mobile-note">{status}</p> : null}
      {found.length > 0 ? (
        <ul aria-label="Files">
          {found.map(path => {
            const slash = path.lastIndexOf('/');
            return (
              <li key={path}>
                <SheetRow
                  onPick={() => {
                    onPick(path);
                  }}
                >
                  <span className="flex flex-col">
                    <span className="truncate">{path.slice(slash + 1)}</span>
                    {slash > 0 ? (
                      <span className="truncate text-small text-text-tertiary">
                        {path.slice(0, slash)}
                      </span>
                    ) : null}
                  </span>
                </SheetRow>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
