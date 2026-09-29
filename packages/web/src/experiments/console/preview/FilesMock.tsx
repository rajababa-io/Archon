/**
 * Mock of the proposed Files tab, in three competing layouts, so the shape can
 * be chosen by looking at it rather than by reading a description.
 *
 * Fixture-backed and inert: no server call, no file API — neither exists yet.
 * The point is the layout decision and the read-only viewer, both of which are
 * legible without real data.
 *
 * The viewer deliberately reuses the console's existing `react-markdown` +
 * `rehype-highlight` stack (the same one `YamlPreview` and `MessageItem` use,
 * with the highlight.js theme imported globally in `index.css`) rather than
 * adding an editor dependency. That is the zero-dependency option made
 * visible: if what you see here is enough to read a file, phase 1 costs no new
 * package. CodeMirror becomes worth its weight only when these panes go
 * editable.
 *
 * Lives under `preview/` rather than `components/` because nothing here ships —
 * deleting this folder removes the mock and nothing else.
 */
import { useMemo, useState, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import {
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  File as FileIcon,
  Folder,
  FolderOpen,
  Search,
} from 'lucide-react';

const REHYPE_PLUGINS = [rehypeHighlight];

// ---------------------------------------------------------------------------
// Fixture tree — real paths from this repo, so the mock reads as the real thing
// ---------------------------------------------------------------------------

interface MockNode {
  name: string;
  kind: 'dir' | 'file';
  children?: MockNode[];
  /** Bytes. Directories carry none. */
  size?: number;
  modified?: string;
  lang?: string;
  content?: string;
}

const SAMPLE_TS = `export type ProjectView = 'overview' | 'runs' | 'chat' | 'issues';

const KEY_PREFIX = 'archon.console.projectView.';

/** Per-project key — one project's choice never leaks into another's. */
export function projectViewKey(projectId: string): string {
  return \`\${KEY_PREFIX}\${projectId}\`;
}

/**
 * Normalise a stored value. Anything unrecognised — a stale key from an older
 * build, a hand-edited value — reads as "no preference" rather than throwing.
 */
export function parseProjectView(raw: string | null): ProjectView | null {
  return raw === 'overview' || raw === 'runs' || raw === 'chat' || raw === 'issues' ? raw : null;
}

export function readProjectView(projectId: string): ProjectView | null {
  try {
    return parseProjectView(localStorage.getItem(projectViewKey(projectId)));
  } catch {
    // Storage access throws with cookies disabled and in some private-browsing
    // modes. "No preference" is a perfectly good answer there.
    return null;
  }
}
`;

const SAMPLE_JSON = `{
  "name": "@archon/web",
  "version": "0.10.1",
  "private": true,
  "type": "module",
  "dependencies": {
    "@tanstack/react-query": "^5.0.0",
    "highlight.js": "^11.11.1",
    "lucide-react": "^0.563.0",
    "react": "^19.0.0",
    "react-markdown": "^9.0.0",
    "react-router": "^7.0.0",
    "rehype-highlight": "^7.0.0"
  }
}
`;

const SAMPLE_MD = `# Working on Archon

Archon is a self-hostable, governed agentic automation engine. It runs
workflows that mix deterministic steps, AI agents, human gates, and audit
trails.

## Read before changing code

- Treat the source, its call sites, and its tests as the current evidence.
- Read every relevant consumer before changing a producer or a contract.
- A question is read-only. Explain first; change code only when asked.
`;

const TREE: MockNode[] = [
  {
    name: 'packages',
    kind: 'dir',
    children: [
      {
        name: 'web',
        kind: 'dir',
        children: [
          {
            name: 'src',
            kind: 'dir',
            children: [
              {
                name: 'experiments',
                kind: 'dir',
                children: [
                  {
                    name: 'console',
                    kind: 'dir',
                    children: [
                      { name: 'components', kind: 'dir', children: [] },
                      { name: 'primitives', kind: 'dir', children: [] },
                      { name: 'routes', kind: 'dir', children: [] },
                      {
                        name: 'lib',
                        kind: 'dir',
                        children: [
                          {
                            name: 'project-view.ts',
                            kind: 'file',
                            size: 1432,
                            modified: '2h ago',
                            lang: 'ts',
                            content: SAMPLE_TS,
                          },
                          { name: 'format.ts', kind: 'file', size: 2210, modified: '3d ago' },
                          { name: 'keymap.ts', kind: 'file', size: 980, modified: '6d ago' },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            name: 'package.json',
            kind: 'file',
            size: 1180,
            modified: '4h ago',
            lang: 'json',
            content: SAMPLE_JSON,
          },
        ],
      },
      { name: 'server', kind: 'dir', children: [] },
      { name: 'core', kind: 'dir', children: [] },
      { name: 'workflows', kind: 'dir', children: [] },
    ],
  },
  { name: '.archon', kind: 'dir', children: [] },
  { name: 'migrations', kind: 'dir', children: [] },
  {
    name: 'AGENTS.md',
    kind: 'file',
    size: 14_820,
    modified: '1d ago',
    lang: 'md',
    content: SAMPLE_MD,
  },
  { name: 'README.md', kind: 'file', size: 6_140, modified: '8d ago' },
];

/** Every path in the fixture, flattened — what a palette would search over. */
function flatten(nodes: MockNode[], prefix: string): { path: string; node: MockNode }[] {
  return nodes.flatMap(node => {
    const path = prefix === '' ? node.name : `${prefix}/${node.name}`;
    const self = { path, node };
    return node.kind === 'dir' && node.children !== undefined
      ? [self, ...flatten(node.children, path)]
      : [self];
  });
}

const ALL_PATHS = flatten(TREE, '');

/** The file the mock opens with, so no layout starts empty. */
const DEFAULT_PATH = 'packages/web/src/experiments/console/lib/project-view.ts';

function findByPath(path: string): MockNode | null {
  return ALL_PATHS.find(entry => entry.path === path)?.node ?? null;
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${String(bytes)} B`;
  return `${String(Math.round(bytes / 1024))} KB`;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * Wrap file text in a fence so `rehype-highlight` picks the grammar. The fence
 * length exceeds the longest backtick run in the content, so a file that itself
 * contains a Markdown fence cannot break out of the block.
 */
function toFence(text: string, lang: string): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

/**
 * Read-only file viewer: gutter plus highlighted source, on the dependency the
 * bundle already carries. Gutter and code share an explicit 20px line box so
 * the numbers line up without a measuring pass.
 */
function Viewer({ node, path }: { node: MockNode | null; path: string }): ReactElement {
  const lineNumbers = useMemo(() => {
    const total =
      node?.content === undefined ? 0 : node.content.replace(/\n$/, '').split('\n').length;
    return Array.from({ length: total }, (_, i) => i + 1);
  }, [node]);

  if (node === null || node.kind === 'dir') {
    return (
      <div className="flex h-full items-center justify-center text-body text-text-tertiary">
        Pick a file
      </div>
    );
  }
  if (node.content === undefined) {
    return (
      <div className="flex h-full flex-col">
        <ViewerHeader path={path} node={node} />
        <div className="flex flex-1 items-center justify-center px-4.75 text-center text-body text-text-tertiary">
          No fixture content for this file — the mock only carries three real bodies.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerHeader path={path} node={node} />
      <div className="flex min-h-0 flex-1 overflow-auto font-mono text-body">
        <div
          aria-hidden
          className="shrink-0 select-none border-r border-border bg-surface-inset px-2.5 py-1.75 text-right leading-[20px] tabular-nums text-text-tertiary"
        >
          {lineNumbers.map(n => (
            <div key={n}>{n}</div>
          ))}
        </div>
        {/* The generated <pre> owns its own padding and background; the child
            selectors strip react-markdown's block margins and let the code
            scroll horizontally without dragging the gutter with it. */}
        <div className="min-w-0 flex-1 [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-3 [&_pre]:leading-[20px] [&_pre_code]:!bg-transparent">
          <ReactMarkdown rehypePlugins={REHYPE_PLUGINS}>
            {toFence(node.content, node.lang ?? '')}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

function ViewerHeader({ path, node }: { path: string; node: MockNode }): ReactElement {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <FileIcon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
      <span className="min-w-0 truncate text-small">
        <span className="text-text-tertiary">{dir}</span>
        <span className="text-text-primary">{node.name}</span>
      </span>
      <span className="ml-auto shrink-0 text-mini text-text-tertiary">
        read-only · {formatSize(node.size)}
      </span>
    </header>
  );
}

interface TreeProps {
  nodes: MockNode[];
  prefix: string;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selected: string;
  onSelect: (path: string) => void;
}

function Tree({
  nodes,
  prefix,
  depth,
  expanded,
  onToggle,
  selected,
  onSelect,
}: TreeProps): ReactElement {
  return (
    <ul className="list-none">
      {nodes.map(node => {
        const path = prefix === '' ? node.name : `${prefix}/${node.name}`;
        const isOpen = expanded.has(path);
        const isSelected = path === selected;
        return (
          <li key={path}>
            <button
              type="button"
              onClick={(): void => {
                if (node.kind === 'dir') onToggle(path);
                else onSelect(path);
              }}
              style={{ paddingLeft: `${String(6 + depth * 12)}px` }}
              className={`flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-body transition-colors ${
                isSelected
                  ? 'bg-surface-elevated text-text-primary'
                  : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
              }`}
            >
              {node.kind === 'dir' ? (
                <>
                  {isOpen ? (
                    <ChevronDown className="h-3 w-3 shrink-0 text-text-tertiary" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0 text-text-tertiary" />
                  )}
                  {isOpen ? (
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent-bright/80" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-accent-bright/60" />
                  )}
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <FileIcon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                </>
              )}
              <span className="truncate">{node.name}</span>
            </button>
            {node.kind === 'dir' && isOpen && node.children !== undefined ? (
              node.children.length === 0 ? (
                <div
                  style={{ paddingLeft: `${String(6 + (depth + 1) * 12 + 18)}px` }}
                  className="py-[3px] text-small italic text-text-tertiary"
                >
                  not expanded in this mock
                </div>
              ) : (
                <Tree
                  nodes={node.children}
                  prefix={path}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                  selected={selected}
                  onSelect={onSelect}
                />
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const DEFAULT_EXPANDED = [
  'packages',
  'packages/web',
  'packages/web/src',
  'packages/web/src/experiments',
  'packages/web/src/experiments/console',
  'packages/web/src/experiments/console/lib',
];

function useTreeState(): {
  expanded: Set<string>;
  toggle: (path: string) => void;
  selected: string;
  select: (path: string) => void;
} {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(DEFAULT_EXPANDED));
  const [selected, setSelected] = useState<string>(DEFAULT_PATH);
  return {
    expanded,
    toggle: (path: string): void => {
      setExpanded(prev => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    selected,
    select: setSelected,
  };
}

// ---------------------------------------------------------------------------
// Option A — Split
// ---------------------------------------------------------------------------

function OptionSplit(): ReactElement {
  const { expanded, toggle, selected, select } = useTreeState();
  return (
    <div className="flex h-[520px] overflow-hidden rounded-lg border border-border bg-surface">
      <div className="w-[260px] shrink-0 overflow-auto border-r border-border bg-surface-inset py-1">
        <Tree
          nodes={TREE}
          prefix=""
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          selected={selected}
          onSelect={select}
        />
      </div>
      <div className="min-w-0 flex-1">
        <Viewer node={findByPath(selected)} path={selected} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Option B — Drill-down
// ---------------------------------------------------------------------------

function childrenAt(path: string): MockNode[] {
  if (path === '') return TREE;
  return findByPath(path)?.children ?? [];
}

function OptionDrill(): ReactElement {
  const [dir, setDir] = useState<string>('packages/web/src/experiments/console/lib');
  const [openFile, setOpenFile] = useState<string | null>(null);

  const crumbs = dir === '' ? [] : dir.split('/');
  const rows = childrenAt(dir);

  return (
    <div className="flex h-[520px] flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.25 text-small">
        <button
          type="button"
          onClick={(): void => {
            setOpenFile(null);
            setDir('');
          }}
          className="text-text-tertiary transition-colors hover:text-text-primary"
        >
          /
        </button>
        {crumbs.map((crumb, i) => (
          <span key={crumbs.slice(0, i + 1).join('/')} className="flex items-center gap-1">
            <button
              type="button"
              onClick={(): void => {
                setOpenFile(null);
                setDir(crumbs.slice(0, i + 1).join('/'));
              }}
              className={
                i === crumbs.length - 1 && openFile === null
                  ? 'text-text-primary'
                  : 'text-text-tertiary transition-colors hover:text-text-primary'
              }
            >
              {crumb}
            </button>
            <span className="text-text-tertiary">/</span>
          </span>
        ))}
        {openFile !== null ? (
          <span className="text-text-primary">{openFile.slice(openFile.lastIndexOf('/') + 1)}</span>
        ) : null}
      </header>

      {openFile !== null ? (
        <div className="min-h-0 flex-1">
          <Viewer node={findByPath(openFile)} path={openFile} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-body italic text-text-tertiary">
              not expanded in this mock
            </div>
          ) : (
            rows.map(node => {
              const path = dir === '' ? node.name : `${dir}/${node.name}`;
              return (
                <button
                  key={path}
                  type="button"
                  onClick={(): void => {
                    if (node.kind === 'dir') setDir(path);
                    else setOpenFile(path);
                  }}
                  className="flex w-full items-center gap-2 border-b border-border/50 px-3 py-1.25 text-left transition-colors hover:bg-surface-hover"
                >
                  {node.kind === 'dir' ? (
                    <Folder className="h-4 w-4 shrink-0 text-accent-bright/70" />
                  ) : (
                    <FileIcon className="h-4 w-4 shrink-0 text-text-tertiary" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-body text-text-primary">
                    {node.name}
                  </span>
                  <span className="shrink-0 text-mini tabular-nums text-text-tertiary">
                    {formatSize(node.size)}
                  </span>
                  <span className="w-16 shrink-0 text-right text-mini text-text-tertiary">
                    {node.modified ?? ''}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Option C — Palette-first
// ---------------------------------------------------------------------------

const RECENT = [
  'packages/web/src/experiments/console/lib/project-view.ts',
  'packages/web/package.json',
  'AGENTS.md',
];

function OptionPalette(): ReactElement {
  const [query, setQuery] = useState<string>('');
  const [selected, setSelected] = useState<string>(DEFAULT_PATH);

  const matches = useMemo(() => {
    const files = ALL_PATHS.filter(entry => entry.node.kind === 'file');
    if (query.trim() === '') return files.filter(entry => RECENT.includes(entry.path));
    const needle = query.toLowerCase();
    return files.filter(entry => entry.path.toLowerCase().includes(needle)).slice(0, 8);
  }, [query]);

  return (
    <div className="flex h-[520px] flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="shrink-0 border-b border-border bg-surface-inset p-3">
        <div className="flex items-center gap-2 rounded-[7px] border border-border-bright bg-surface px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
          <input
            value={query}
            onChange={(e): void => {
              setQuery(e.target.value);
            }}
            placeholder="Find a file by path…  (⌘P)"
            className="min-w-0 flex-1 bg-transparent font-mono text-body text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
        <div className="mt-2 max-h-[150px] overflow-auto">
          {query.trim() === '' ? (
            <div className="px-1 pb-1 text-mini font-medium text-text-tertiary">Recent</div>
          ) : null}
          {matches.length === 0 ? (
            <div className="px-1 py-1.25 text-small text-text-tertiary">No match</div>
          ) : (
            matches.map(entry => (
              <button
                key={entry.path}
                type="button"
                onClick={(): void => {
                  setSelected(entry.path);
                }}
                className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors ${
                  entry.path === selected ? 'bg-surface-elevated' : 'hover:bg-surface-hover'
                }`}
              >
                <FileIcon className="h-3 w-3 shrink-0 text-text-tertiary" />
                <span className="min-w-0 truncate font-mono text-small">
                  <span className="text-text-primary">
                    {entry.path.slice(entry.path.lastIndexOf('/') + 1)}
                  </span>
                  <span className="ml-1.5 text-text-tertiary">
                    {entry.path.includes('/')
                      ? entry.path.slice(0, entry.path.lastIndexOf('/'))
                      : ''}
                  </span>
                </span>
                {entry.path === selected ? (
                  <CornerDownLeft className="ml-auto h-3 w-3 shrink-0 text-text-tertiary" />
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Viewer node={findByPath(selected)} path={selected} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The switcher
// ---------------------------------------------------------------------------

type OptionKey = 'split' | 'drill' | 'palette';

const OPTIONS: readonly {
  key: OptionKey;
  label: string;
  blurb: string;
  cost: string;
}[] = [
  {
    key: 'split',
    label: 'A · Split',
    blurb:
      'Tree pinned left, viewer right — the Cursor shape. Orientation is always on screen and moving between two files is one click.',
    cost: 'Server: list one directory. Costs ~260px of width permanently, and gets cramped on a narrow window.',
  },
  {
    key: 'drill',
    label: 'B · Drill-down',
    blurb:
      'One pane at a time: a directory listing with a breadcrumb, which swaps to the file when you open one. Full width for both.',
    cost: 'Server: list one directory — the same endpoint as A. Simplest to build, works on a phone. Comparing two files means going back.',
  },
  {
    key: 'palette',
    label: 'C · Palette-first',
    blurb:
      'Finding beats browsing: a fuzzy path search over the whole repo, with the viewer underneath. Matches how you already move around a repo you know.',
    cost: 'Server: needs a recursive file index, not just a directory listing — the only option with materially more backend. Poor for exploring an unfamiliar tree.',
  },
];

/** The tab strip with Files added, so the mock answers "where does it live". */
function MockTabs(): ReactElement {
  const tabs = ['Overview', 'Chat', 'Runs', 'Issues', 'Files'];
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1.5">
      {tabs.map(label => {
        const isActive = label === 'Files';
        return (
          <span
            key={label}
            className={`relative rounded px-2 py-1 text-small font-medium ${
              isActive ? 'bg-surface-elevated text-text-primary' : 'text-text-tertiary'
            }`}
          >
            {label}
            {isActive ? (
              <span
                aria-hidden
                className="brand-bar pointer-events-none absolute inset-x-1 -bottom-0.5 h-0.5 rounded-full"
              />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export function FilesMock(): ReactElement {
  const [option, setOption] = useState<OptionKey>('split');
  const active = OPTIONS.find(o => o.key === option) ?? OPTIONS[0];

  return (
    <div className="flex flex-col gap-x-2.25 gap-y-1.75">
      <MockTabs />

      <div className="flex flex-wrap gap-x-2 gap-y-1.25">
        {OPTIONS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={(): void => {
              setOption(key);
            }}
            className={`rounded border px-2.5 py-1 text-small transition-colors ${
              key === option
                ? 'border-accent-bright/60 bg-surface-elevated text-text-primary'
                : 'border-border bg-surface text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {option === 'split' ? <OptionSplit /> : null}
      {option === 'drill' ? <OptionDrill /> : null}
      {option === 'palette' ? <OptionPalette /> : null}

      <div className="rounded-lg border border-border bg-surface-inset p-3">
        <p className="text-body leading-relaxed text-text-secondary">{active?.blurb}</p>
        <p className="mt-1.5 text-small leading-relaxed text-text-tertiary">{active?.cost}</p>
      </div>

      <p className="text-small leading-relaxed text-text-tertiary">
        Fixture-backed — no file API exists yet, and only three files carry real bodies. The viewer
        is the console&rsquo;s existing highlight.js path, so what you see here is the
        zero-new-dependency option rendering for real. Folders marked &ldquo;not expanded in this
        mock&rdquo; would load on click from a per-directory listing endpoint.
      </p>
    </div>
  );
}
