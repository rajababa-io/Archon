import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { FileText, Image as ImageIcon } from 'lucide-react';
import * as skill from '../../skills';
import type { ArtifactFile } from '../../skills/runs';
import { useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { errorDetail } from '../../lib/http';
import { formatBytes } from '../../primitives/file-entry';
import { Markdown } from '../../components/Markdown';
import { codeFence, fileView } from '../lib/file-view';
import { ImageViewer } from './ImageViewer';

/**
 * The files a run wrote, from the same listing as the desktop's Artifacts
 * tab. Pictures open in the image viewer, swiping between the run's pictures;
 * anything else opens in place, markdown rendered and the rest highlighted.
 */
export function ArtifactList({ runId }: { runId: string }): ReactElement {
  const { data: files, error } = useEntity<ArtifactFile[]>(K.artifacts(runId), () =>
    skill.listRunArtifacts(runId)
  );
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const images = useMemo(
    () =>
      (files ?? [])
        .filter(f => fileView(f.path) === 'image')
        .map(f => ({ src: skill.artifactUrl(runId, f.path), alt: f.path })),
    [files, runId]
  );

  return (
    <section aria-label="Artifacts" className="flex flex-col">
      <h2 className="pb-1 text-mini font-medium text-text-tertiary uppercase">Artifacts</h2>
      {error !== undefined ? (
        <p className="text-small text-error">
          Couldn&apos;t list this run&apos;s files: {error.message}
        </p>
      ) : files === undefined ? (
        <p className="text-small text-text-tertiary">Listing…</p>
      ) : files.length === 0 ? (
        <p className="text-body text-text-tertiary">This run wrote no files.</p>
      ) : (
        <ul className="flex flex-col">
          {files.map(file => {
            const isImage = fileView(file.path) === 'image';
            const open = openPath === file.path;
            return (
              <li key={file.path}>
                <button
                  type="button"
                  aria-expanded={isImage ? undefined : open}
                  onClick={() => {
                    if (isImage) {
                      setViewing(images.findIndex(i => i.alt === file.path));
                    } else {
                      setOpenPath(open ? null : file.path);
                    }
                  }}
                  className="mobile-row flex w-full items-center gap-3 text-left"
                >
                  {isImage ? (
                    <ImageIcon aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
                  ) : (
                    <FileText aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-small text-text-primary">
                    {file.path}
                  </span>
                  <span className="shrink-0 text-small tabular-nums text-text-tertiary">
                    {formatBytes(file.size)}
                  </span>
                </button>
                {open ? <ArtifactText runId={runId} path={file.path} /> : null}
              </li>
            );
          })}
        </ul>
      )}
      {viewing !== null && viewing >= 0 ? (
        <ImageViewer
          images={images}
          start={viewing}
          onClose={() => {
            setViewing(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ArtifactText({ runId, path }: { runId: string; path: string }): ReactElement {
  const [text, setText] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    skill.fetchArtifact(runId, path).then(
      body => {
        if (live) setText(body);
      },
      (err: unknown) => {
        if (live) setFailure(errorDetail(err));
      }
    );
    return (): void => {
      live = false;
    };
  }, [runId, path]);

  if (failure !== null) return <p className="pb-2 text-small text-error">{failure}</p>;
  if (text === null) return <p className="pb-2 text-small text-text-tertiary">Opening…</p>;
  return (
    <div className="chat-markdown min-w-0 overflow-x-auto pb-3 text-body text-text-primary">
      <Markdown>{fileView(path) === 'markdown' ? text : codeFence(text, path)}</Markdown>
    </div>
  );
}
