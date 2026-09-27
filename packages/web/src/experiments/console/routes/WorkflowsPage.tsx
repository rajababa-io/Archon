import { useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { Plus, Search } from 'lucide-react';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import {
  listProjects,
  listRuns,
  listWorkflows,
  RUN_LIMIT,
  type WorkflowListResult,
} from '../skills';
import type { Project } from '../primitives/project';
import type { Run } from '../primitives/run';
import { useBuilderProject } from '../builder/connect/use-builder-project';
import { buildCatalog, type CatalogRow } from '../lib/workflow-catalog';
import { relativeTime } from '../lib/format';
import { statusLabel } from '../lib/run-status';
import { StatusDot } from '../components/StatusDot';
import { SELECT_CLASS_COMPACT, SelectShell } from '../components/SettingsFormPrimitives';

type SourceTab = 'all' | 'project' | 'bundled' | 'global';

const TABS: readonly { id: SourceTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'project', label: 'Project' },
  { id: 'bundled', label: 'Built-in' },
  { id: 'global', label: 'Global' },
];

/** Which tab a workflow counts under. An unrecognised source is a project one — see buildCatalog. */
function tabOf(source: string): Exclude<SourceTab, 'all'> {
  return source === 'bundled' || source === 'global' ? source : 'project';
}

/**
 * Every workflow the selected project can run, recently used first. A row opens
 * the workflow in the builder; "New workflow" opens the builder's create flow.
 *
 * The project is the builder's own selection (`useBuilderProject`), so the
 * builder opens on the project this page was showing and the choice survives
 * moving between the two.
 */
export function WorkflowsPage(): ReactElement {
  const navigate = useNavigate();
  const { projectId, setProjectId } = useBuilderProject();
  const [tab, setTab] = useState<SourceTab>('all');
  const [query, setQuery] = useState('');

  const projects = useEntity<Project[]>(K.projects, () => listProjects()).data ?? [];
  // Fall back to the first project rather than an empty page: every install
  // with a project has workflows to show, and the picker says which one this is.
  const project = projects.find(p => p.id === projectId) ?? projects[0];
  const cwd = project?.path;

  const list = useEntity<WorkflowListResult>(
    cwd !== undefined ? K.workflows(cwd) : 'workflows:idle',
    () =>
      cwd !== undefined
        ? listWorkflows(cwd)
        : Promise.resolve({ workflows: [], recommended: [], stepCounts: {} })
  );
  const runs = useEntity<{ runs: Run[] }>(
    project !== undefined ? K.runs(project.id) : 'noop:no-project-runs',
    () =>
      project !== undefined
        ? listRuns({ codebaseId: project.id, limit: RUN_LIMIT })
        : Promise.resolve({ runs: [] })
  );

  const workflows = list.data?.workflows ?? [];
  const counts = useMemo(() => {
    const c: Record<SourceTab, number> = {
      all: workflows.length,
      project: 0,
      bundled: 0,
      global: 0,
    };
    for (const w of workflows) c[tabOf(w.source)] += 1;
    return c;
  }, [workflows]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = workflows.filter(
      w =>
        (tab === 'all' || tabOf(w.source) === tab) &&
        (q === '' ||
          w.name.toLowerCase().includes(q) ||
          (w.description ?? '').toLowerCase().includes(q))
    );
    return buildCatalog(shown, list.data?.stepCounts ?? {}, runs.data?.runs ?? []);
  }, [workflows, tab, query, list.data, runs.data]);

  const projectQuery = project !== undefined ? `?project=${encodeURIComponent(project.id)}` : '';
  const open = (row: CatalogRow): void => {
    navigate(`/console/builder/${encodeURIComponent(row.name)}${projectQuery}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-5">
        <h1 className="text-large font-semibold text-text-primary">Workflows</h1>
        <nav aria-label="Source" className="ml-2 flex gap-0.5">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tab === t.id}
              onClick={() => {
                setTab(t.id);
              }}
              className={`rounded-md px-2.5 py-1 text-body font-medium transition-colors ${
                tab === t.id
                  ? 'bg-surface-hover text-text-primary'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label}
              <span className="ml-1.5 text-text-tertiary">{counts[t.id]}</span>
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex h-7 w-56 items-center gap-1.5 rounded-md border border-border px-2.5 text-body text-text-tertiary focus-within:border-accent-bright/50">
            <Search aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <input
              value={query}
              onChange={e => {
                setQuery(e.target.value);
              }}
              placeholder="Filter workflows…"
              aria-label="Filter workflows"
              className="min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </label>
          <SelectShell className="w-44">
            <select
              aria-label="Project"
              value={project?.id ?? ''}
              onChange={e => {
                setProjectId(e.target.value);
              }}
              className={SELECT_CLASS_COMPACT}
            >
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </SelectShell>
          <button
            type="button"
            disabled={project === undefined}
            onClick={() => {
              navigate(`/console/builder${projectQuery}${projectQuery === '' ? '?' : '&'}new=1`);
            }}
            className="flex h-7 items-center gap-1 rounded-md bg-accent px-3 text-body font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-40"
          >
            <Plus aria-hidden className="h-3.5 w-3.5" />
            New workflow
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.error !== undefined ? (
          <p className="px-5 py-4 text-body text-error">
            Could not load workflows: {list.error.message}
          </p>
        ) : project === undefined ? (
          <p className="px-5 py-4 text-body text-text-tertiary">
            Add a project to see its workflows.
          </p>
        ) : list.data === undefined ? (
          <p className="px-5 py-4 text-body text-text-tertiary">Loading workflows…</p>
        ) : groups.length === 0 ? (
          <p className="px-5 py-4 text-body text-text-tertiary">No workflows match.</p>
        ) : (
          groups.map(group => (
            <section key={group.id} aria-label={group.label}>
              <h2 className="flex h-8 items-center gap-2 border-b border-border bg-surface-inset px-5 text-body font-medium text-text-primary">
                {group.label}
                <span className="text-text-tertiary">{group.rows.length}</span>
              </h2>
              {group.rows.map(row => (
                <WorkflowRow
                  key={row.name}
                  row={row}
                  onOpen={() => {
                    open(row);
                  }}
                />
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function WorkflowRow({ row, onOpen }: { row: CatalogRow; onOpen: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Open ${row.name} in the builder`}
      className="group flex h-[2.375rem] w-full items-center gap-3 border-b border-border px-5 text-left text-body transition-colors hover:bg-surface-hover"
    >
      <span className="flex w-2 shrink-0 justify-center">
        {row.lastStatus !== null ? (
          <span title={`Last run: ${statusLabel[row.lastStatus]}`} className="flex">
            <StatusDot status={row.lastStatus} size={7} />
          </span>
        ) : (
          <span
            title="Never run"
            className="h-[7px] w-[7px] rounded-full border border-border-bright"
          />
        )}
      </span>
      <span className="shrink-0 font-medium text-text-primary">{row.name}</span>
      <span className="min-w-0 flex-1 truncate text-text-tertiary">{row.summary}</span>
      <span className="hidden shrink-0 font-medium text-accent-bright group-hover:inline">
        Open in builder →
      </span>
      <span className="w-16 shrink-0 whitespace-nowrap text-right tabular-nums text-text-secondary">
        {row.steps} {row.steps === 1 ? 'step' : 'steps'}
      </span>
      <span className="w-16 shrink-0 whitespace-nowrap text-right tabular-nums text-text-secondary">
        {row.runs > 0 ? `${String(row.runs)} ${row.runs === 1 ? 'run' : 'runs'}` : '—'}
      </span>
      <span className="w-16 shrink-0 whitespace-nowrap text-right tabular-nums text-text-tertiary">
        {row.lastStartedAt !== null ? relativeTime(row.lastStartedAt) : ''}
      </span>
    </button>
  );
}
