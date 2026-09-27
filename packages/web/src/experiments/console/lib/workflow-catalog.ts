import type { Workflow } from '../primitives/workflow';
import type { Run } from '../primitives/run';
import type { RunStatus } from './run-status';

/** One row of the Workflows page. */
export interface CatalogRow {
  name: string;
  /** The first sentence of the description, with a leading `Use when:` dropped. */
  summary: string;
  source: Workflow['source'];
  steps: number;
  /** Runs of this workflow within the loaded run window, not all time. */
  runs: number;
  lastStatus: RunStatus | null;
  lastStartedAt: string | null;
}

export type CatalogGroupId = 'recent' | 'project' | 'global' | 'bundled';

export interface CatalogGroup {
  id: CatalogGroupId;
  label: string;
  rows: CatalogRow[];
}

const GROUP_LABEL: Record<CatalogGroupId, string> = {
  recent: 'Used recently',
  project: 'Project workflows',
  global: 'Global',
  bundled: 'Built-in',
};

/**
 * Bundled descriptions are written for the router, as `Use when: …` followed
 * by more labelled lines. A list row has room for one sentence of that.
 */
export function summarize(description: string | null): string {
  if (description === null) return '';
  const text = description.trim();
  const useWhen = /Use when:\s*([^\n]+)/.exec(text);
  const line = (useWhen?.[1] ?? text.split('\n')[0] ?? '').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line);
  return sentence?.[1] ?? line;
}

/**
 * Group workflows for the page: every workflow that has run sits in "Used
 * recently", newest run first, and the rest are grouped by where they live.
 * A workflow appears once — in the first group that claims it.
 *
 * An unrecognised source falls in with project workflows rather than being
 * dropped: hiding a workflow the server listed is worse than filing it under
 * the nearest heading.
 */
export function buildCatalog(
  workflows: readonly Workflow[],
  stepCounts: Readonly<Record<string, number>>,
  runs: readonly Run[]
): CatalogGroup[] {
  const byName = new Map<string, Run[]>();
  for (const run of runs) {
    const list = byName.get(run.workflow);
    if (list === undefined) byName.set(run.workflow, [run]);
    else list.push(run);
  }

  const rows: CatalogRow[] = workflows.map(w => {
    const own = byName.get(w.name) ?? [];
    const last = own.reduce<Run | null>(
      (best, r) => (best === null || r.startedAt > best.startedAt ? r : best),
      null
    );
    return {
      name: w.name,
      summary: summarize(w.description),
      source: w.source,
      steps: stepCounts[w.name] ?? 0,
      runs: own.length,
      lastStatus: last?.status ?? null,
      lastStartedAt: last?.startedAt ?? null,
    };
  });

  const buckets: Record<CatalogGroupId, CatalogRow[]> = {
    recent: [],
    project: [],
    global: [],
    bundled: [],
  };
  for (const row of rows) {
    if (row.runs > 0) buckets.recent.push(row);
    else if (row.source === 'bundled') buckets.bundled.push(row);
    else if (row.source === 'global') buckets.global.push(row);
    else buckets.project.push(row);
  }
  buckets.recent.sort((a, b) => (b.lastStartedAt ?? '').localeCompare(a.lastStartedAt ?? ''));
  for (const id of ['project', 'global', 'bundled'] as const) {
    buckets[id].sort((a, b) => a.name.localeCompare(b.name));
  }

  return (['recent', 'project', 'global', 'bundled'] as const)
    .filter(id => buckets[id].length > 0)
    .map(id => ({ id, label: GROUP_LABEL[id], rows: buckets[id] }));
}
