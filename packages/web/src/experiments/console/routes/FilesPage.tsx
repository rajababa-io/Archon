/**
 * Files - read and edit a project's checkout.
 *
 * Replaced a hand-rolled tree and viewer. The libraries earn their place on
 * measurement, not taste: code folding, find-in-file, arrow-key navigation and
 * row virtualisation for +0.67 kB gzip on the initial bundle, because the whole
 * thing is lazy (see below).
 *
 * EDITABLE. A save carries the `etag` the read returned, so the server can
 * refuse a write against a file that changed underneath it (409) rather than
 * discard whatever wrote it. That refusal is shown, never retried through.
 *
 * EVERY BYTE OF THIS IS LAZY. ConsoleApp mounts it through React.lazy, so the
 * libraries are absent from the initial bundle entirely, and the language
 * grammars arrive per file type (lib/code-language.ts). A session that never
 * opens this tab pays nothing for it.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Tree, type NodeApi, type NodeRendererProps } from 'react-arborist';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import * as skill from '../skills';
import { EmptyState } from '../components/EmptyState';
import { HttpError } from '../lib/http';
import { loadLanguage } from '../lib/code-language';
import ReactMarkdown, { type Components } from 'react-markdown';
import { MD_COMPONENTS, MD_REHYPE_PLUGINS, MD_REMARK_PLUGINS } from '../components/Markdown';
import {
  formatBytes,
  hasPreview,
  isHtmlPath,
  isImagePath,
  type FileEntry,
} from '../primitives/file-entry';

/** A node as react-arborist wants it. `children === undefined` means leaf. */
interface Node {
  id: string;
  name: string;
  kind: FileEntry['kind'];
  size: number | null;
  children?: Node[];
}

/**
 * Stand-in child for a directory nobody has opened yet.
 *
 * Not `[]`: arborist reads an empty array as a genuinely empty folder and
 * renders no twisty, so the directory could never be opened to load it.
 */
const UNREAD: Node[] = [{ id: ' unread', name: 'Loading...', kind: 'other', size: null }];

/** The server's own words for a refusal - "binary file", "too large", "not found". */
function refusalMessage(error: Error): string {
  if (!(error instanceof HttpError)) return error.message;
  try {
    const parsed: unknown = JSON.parse(error.bodySnippet);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const value = (parsed as { error: unknown }).error;
      if (typeof value === 'string') return value;
    }
  } catch {
    // Not JSON, or cut mid-object by the snippet cap.
  }
  return `Could not read this file (HTTP ${String(error.status)}).`;
}

const THEME = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--color-surface)', color: 'var(--color-text-primary)' },
    '.cm-gutters': {
      backgroundColor: 'var(--color-surface-inset)',
      color: 'var(--color-text-tertiary)',
      border: 'none',
      borderRight: '1px solid var(--color-border)',
    },
    '.cm-activeLine': { backgroundColor: 'var(--color-surface-elevated)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--color-surface-elevated)' },
  },
  { dark: true }
);

function Row({ node, style }: NodeRendererProps<Node>): ReactElement {
  const entry = node.data;
  return (
    <div
      style={style}
      className={`flex h-full cursor-pointer items-center gap-1.5 pr-2 text-body ${
        node.isSelected
          ? 'bg-surface-elevated text-text-primary'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
      }`}
      onClick={() => {
        if (entry.kind === 'dir') node.toggle();
      }}
    >
      <span aria-hidden className="w-3 shrink-0 text-mini text-text-tertiary">
        {entry.kind === 'dir' ? (node.isOpen ? 'v' : '>') : ''}
      </span>
      <span className="truncate">{entry.name}</span>
      {entry.kind === 'file' ? (
        <span className="ml-auto shrink-0 text-mini tabular-nums text-text-tertiary">
          {formatBytes(entry.size)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Rendered view of a file that has one.
 *
 * HTML goes in a SANDBOXED IFRAME with neither `allow-scripts` nor
 * `allow-same-origin`. Repo HTML is untrusted input: rendered on this origin it
 * would run with the console's cookies and DOM. Those two flags together are
 * the combination that hands it exactly that, so neither is present - the
 * frame paints markup and CSS and can do nothing else.
 *
 * Markdown is rendered in-process because it is not executable: the same
 * react-markdown path the rest of the console already uses, with relative
 * image sources rewritten onto the raw route so a README's screenshots resolve.
 */
function Preview({
  projectId,
  path,
  text,
}: {
  projectId: string;
  path: string;
  text: string;
}): ReactElement {
  if (isHtmlPath(path)) {
    return (
      <iframe
        title={`Preview of ${path}`}
        sandbox=""
        srcDoc={text}
        className="h-full w-full border-0 bg-white"
      />
    );
  }

  // The console's own markdown stack, plus one rule it has never needed: a
  // README's relative image is a file in the repo.
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
    <div className="chat-markdown h-full overflow-auto px-4.75 py-2.5 text-body leading-relaxed text-text-primary">
      <ReactMarkdown
        remarkPlugins={MD_REMARK_PLUGINS}
        rehypePlugins={MD_REHYPE_PLUGINS}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function FilesPage(): ReactElement {
  const { projectId } = useParams<{ projectId: string }>();
  // The open file lives in the URL, so a file is linkable and survives a
  // reload - the gap v1 has.
  const [params, setParams] = useSearchParams();
  const selected = params.get('file');

  const [loaded, setLoaded] = useState<Record<string, FileEntry[]>>({});
  const [content, setContent] = useState<string | null>(null);
  // What the server last confirmed, and the version it was. `draft` differs
  // from `content` exactly when there are unsaved edits, which is the only
  // definition of dirty this needs.
  const [draft, setDraft] = useState<string>('');
  const [etag, setEtag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [language, setLanguage] = useState<Extension[]>([]);
  const [filter, setFilter] = useState('');
  // Preview is the default for files that HAVE one: opening a README to read
  // its source is the unusual case, not the common one.
  const [showSource, setShowSource] = useState(false);

  const load = useCallback(
    (dir: string) => {
      if (projectId === undefined) return;
      void skill.listFiles(projectId, dir).then(
        entries => {
          setLoaded(prev => ({ ...prev, [dir]: entries }));
        },
        () => {
          // An unreadable directory reads as empty rather than taking the tree
          // down; the row stays, and its contents simply are not there.
          setLoaded(prev => ({ ...prev, [dir]: [] }));
        }
      );
    },
    [projectId]
  );

  useEffect(() => {
    setLoaded({});
    load('');
  }, [load]);

  useEffect(() => {
    if (projectId === undefined || selected === null) {
      setContent(null);
      return;
    }
    let live = true;
    setContent(null);
    setViewerError(null);
    setShowSource(false);
    if (isImagePath(selected)) {
      // The text route would refuse this as binary, correctly. Asking it
      // anyway would paint a refusal over a file the viewer can show.
      return;
    }
    void skill.readFileContent(projectId, selected).then(
      res => {
        if (!live) return;
        setContent(res.content);
        setDraft(res.content);
        setEtag(res.etag);
        setSaveError(null);
        setSavedAt(null);
      },
      (err: Error) => {
        if (live) setViewerError(refusalMessage(err));
      }
    );
    void loadLanguage(selected).then(ext => {
      if (live) setLanguage(ext);
    });
    setShowSource(false);
    return (): void => {
      live = false;
    };
  }, [projectId, selected]);

  const data = useMemo<Node[]>(() => {
    const build = (dir: string): Node[] =>
      (loaded[dir] ?? []).map(entry => {
        if (entry.kind !== 'dir') {
          return { id: entry.path, name: entry.name, kind: entry.kind, size: entry.size };
        }
        return {
          id: entry.path,
          name: entry.name,
          kind: entry.kind,
          size: entry.size,
          children: loaded[entry.path] === undefined ? UNREAD : build(entry.path),
        };
      });
    return build('');
  }, [loaded]);

  const dirty = content !== null && draft !== content;

  const save = useCallback((): void => {
    if (projectId === undefined || selected === null || etag === null || saving) return;
    setSaving(true);
    setSaveError(null);
    void skill.writeFileContent(projectId, selected, draft, etag).then(
      res => {
        // The saved text IS the file now, so it becomes the baseline and the
        // new token is what the next save will be judged against.
        setContent(draft);
        setEtag(res.etag);
        setSavedAt(Date.now());
        setSaving(false);
      },
      (err: Error) => {
        // A 409 means someone else wrote the file. Surfaced and left alone -
        // retrying with a fresh token is exactly the silent overwrite the
        // token exists to prevent.
        setSaveError(refusalMessage(err));
        setSaving(false);
      }
    );
  }, [projectId, selected, etag, draft, saving]);

  // Cmd/Ctrl-S, because nobody reaches for a button to save a file.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [save]);

  if (projectId === undefined) {
    return <EmptyState title="No project" hint="Pick a project to read its files." />;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface-inset/40">
        <input
          value={filter}
          onChange={e => {
            setFilter(e.target.value);
          }}
          placeholder="Filter loaded tree..."
          className="m-2 rounded border border-border bg-surface px-2 py-1 font-mono text-small text-text-primary outline-none focus:border-border-bright"
        />
        <div className="min-h-0 flex-1">
          <Tree<Node>
            data={data}
            openByDefault={false}
            width="100%"
            height={720}
            indent={14}
            rowHeight={22}
            searchTerm={filter}
            searchMatch={(node, term): boolean =>
              node.data.name.toLowerCase().includes(term.toLowerCase())
            }
            disableDrag
            disableDrop
            onToggle={id => {
              // Fetch a directory the first time it is opened, and never again.
              if (loaded[id] === undefined) load(id);
            }}
            onActivate={(node: NodeApi<Node>) => {
              if (node.data.kind !== 'file') return;
              setParams(prev => {
                const next = new URLSearchParams(prev);
                next.set('file', node.data.id);
                return next;
              });
            }}
          >
            {Row}
          </Tree>
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.25">
          <span className="min-w-0 truncate font-mono text-body text-text-secondary">
            {selected ?? 'No file selected'}
          </span>
          {selected !== null && hasPreview(selected) ? (
            <button
              type="button"
              onClick={() => {
                setShowSource(v => !v);
              }}
              className="shrink-0 rounded border border-border px-2 py-0.5 text-small text-text-secondary transition-colors hover:text-text-primary"
            >
              {showSource ? 'Preview' : 'Source'}
            </button>
          ) : null}
          {dirty ? (
            <span aria-label="Unsaved changes" className="shrink-0 text-small text-warning">
              unsaved
            </span>
          ) : savedAt !== null ? (
            <span className="shrink-0 text-small text-text-tertiary">saved</span>
          ) : null}
          {selected !== null ? (
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="shrink-0 rounded border border-border px-2 py-0.5 text-small text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          ) : null}
        </header>
        {saveError !== null ? (
          <p className="shrink-0 border-b border-error/30 bg-error/[0.06] px-3 py-1.5 text-small text-error">
            {saveError}
          </p>
        ) : null}
        {selected === null ? (
          <EmptyState
            title="Nothing open"
            hint="Arrow keys move the tree. Cmd-F searches the file."
          />
        ) : viewerError !== null ? (
          <p className="px-4.75 py-2.5 text-body text-error">{viewerError}</p>
        ) : isImagePath(selected) ? (
          // Images never reach the text route - the server refuses them as
          // binary - so they are loaded by URL from the raw route instead.
          <div className="min-h-0 flex-1 overflow-auto bg-surface-inset/30 p-6">
            <img
              src={skill.rawFileUrl(projectId, selected)}
              alt={selected}
              className="max-w-full"
            />
          </div>
        ) : content === null ? (
          <p className="px-4.75 py-2.5 text-body text-text-tertiary">Loading...</p>
        ) : hasPreview(selected) && !showSource ? (
          <div className="min-h-0 flex-1">
            <Preview projectId={projectId} path={selected} text={draft} />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">
            <CodeMirror
              value={draft}
              onChange={setDraft}
              height="100%"
              style={{ height: '100%' }}
              theme={THEME}
              extensions={language}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                searchKeymap: true,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                autocompletion: false,
              }}
            />
          </div>
        )}
      </section>
    </div>
  );
}

export default FilesPage;
