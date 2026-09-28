import { useState, type ReactElement } from 'react';
import { useParams } from 'react-router';
import ReactMarkdown, { type Components } from 'react-markdown';
import * as skill from '../../skills';
import type { FileContent } from '../../skills/files';
import { useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { parentPath } from '../../primitives/file-entry';
import {
  MD_COMPONENTS,
  MD_REHYPE_PLUGINS,
  MD_REMARK_PLUGINS,
  Markdown,
} from '../../components/Markdown';
import { ScreenHeader } from '../components/ScreenHeader';
import { ImageViewer } from '../components/ImageViewer';
import { codeFence, fileView } from '../lib/file-view';
import { directoryPath } from '../lib/paths';

/**
 * `/m/files/:projectId/*` — one file of a project's checkout, read-only:
 * markdown rendered, code highlighted, a picture shown and opened full screen
 * with a tap.
 */
export function FileScreen(): ReactElement {
  const { projectId = '', '*': path = '' } = useParams<{ projectId: string; '*': string }>();
  const name = path.slice(path.lastIndexOf('/') + 1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        back={directoryPath(projectId, parentPath(path) ?? '')}
        backLabel="Back to the folder"
        title={name === '' ? 'File' : name}
        context={parentPath(path) || null}
      />
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {fileView(path) === 'image' ? (
          <Picture src={skill.rawFileUrl(projectId, path)} alt={path} />
        ) : (
          <TextFile projectId={projectId} path={path} />
        )}
      </div>
    </div>
  );
}

function Picture({ src, alt }: { src: string; alt: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="Open full screen"
        onClick={() => {
          setOpen(true);
        }}
        className="block w-full"
      >
        <img src={src} alt={alt} className="mx-auto max-w-full" />
      </button>
      {open ? (
        <ImageViewer
          images={[{ src, alt }]}
          start={0}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function TextFile({ projectId, path }: { projectId: string; path: string }): ReactElement {
  const { data: file, error } = useEntity<FileContent>(K.fileContent(projectId, path), () =>
    skill.readFileContent(projectId, path)
  );
  if (error !== undefined) {
    return <p className="text-body text-error">Couldn&apos;t open this file: {error.message}</p>;
  }
  if (file === undefined) return <p className="text-body text-text-tertiary">Opening…</p>;

  if (fileView(path) === 'markdown') {
    const components: Components = {
      ...MD_COMPONENTS,
      img: ({ src, alt }) => (
        <img
          src={skill.repoImageUrl(projectId, path, typeof src === 'string' ? src : '')}
          alt={alt ?? ''}
          className="max-w-full"
        />
      ),
    };
    return (
      <div className="chat-markdown text-body leading-relaxed text-text-primary">
        <ReactMarkdown
          remarkPlugins={MD_REMARK_PLUGINS}
          rehypePlugins={MD_REHYPE_PLUGINS}
          components={components}
        >
          {file.content}
        </ReactMarkdown>
      </div>
    );
  }
  return (
    <div className="chat-markdown text-body">
      <Markdown>{codeFence(file.content, path)}</Markdown>
    </div>
  );
}
