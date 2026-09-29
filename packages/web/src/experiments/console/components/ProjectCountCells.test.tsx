import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectCountCells, ProjectCountTotals, sumProjectCounts } from './ProjectCountCells';
import { set } from '../store/cache';
import { K } from '../store/keys';
import type { ProjectCounts } from '../skills';

function seed(projectId: string, counts: Partial<ProjectCounts>): void {
  set(K.projectCounts(projectId), {
    chats: 0,
    runs: 0,
    running: 0,
    awaiting: 0,
    chatIds: [],
    issues: null,
    ...counts,
  } satisfies ProjectCounts);
}

/** The digits a row draws, in column order: runs, chats, issues. */
function cells(markup: string): string[] {
  return [...markup.matchAll(/<span[^>]*class="cell[^"]*"[^>]*>(.*?)<\/span>/g)].map(m => m[1]);
}

/**
 * Three project rows once showed the SAME pair of numbers, which belonged to a
 * fourth project. Each row reads its own `projectCounts:<id>` entry, so a row
 * drawing another project's figures means those figures were written under the
 * wrong key — see `loaderForKey` in store/cache.
 */
describe('ProjectCountCells', () => {
  test('two projects with different counts render different numbers', () => {
    seed('pcc-archon', { chats: 15, runs: 3, running: 3, issues: 28 });
    seed('pcc-vault', { chats: 2, runs: 1, running: 1, issues: 12 });

    expect(cells(renderToStaticMarkup(<ProjectCountCells projectId="pcc-archon" />))).toEqual([
      '3',
      '15',
      '28',
    ]);
    expect(cells(renderToStaticMarkup(<ProjectCountCells projectId="pcc-vault" />))).toEqual([
      '1',
      '2',
      '12',
    ]);
  });

  test('none and unknown both render blank, and the tooltip carries the difference', () => {
    seed('pcc-none', { chats: 0, runs: 0, issues: 0 });
    seed('pcc-unknown', { chats: 0, runs: 0, issues: null });

    const none = renderToStaticMarkup(<ProjectCountCells projectId="pcc-none" />);
    const unknown = renderToStaticMarkup(<ProjectCountCells projectId="pcc-unknown" />);

    // A `0` in the issues column would claim the repo has no open issues, which
    // is a different statement from "this repo cannot be asked".
    expect(cells(none)).toEqual(['', '', '']);
    expect(cells(unknown)).toEqual(['', '', '']);
    expect(none).toContain('0 open issues');
    expect(unknown).toContain('not available for this project');
  });

  test('waiting on you outranks running', () => {
    seed('pcc-amber', { runs: 4, running: 2, awaiting: 1 });
    const markup = renderToStaticMarkup(<ProjectCountCells projectId="pcc-amber" />);
    expect(markup).toContain('needs-you');
    expect(markup).toContain('1 waiting on you');
  });
});

function counts(over: Partial<ProjectCounts>): ProjectCounts {
  return { chats: 0, chatIds: [], runs: 0, running: 0, awaiting: 0, issues: 0, ...over };
}

describe('sumProjectCounts', () => {
  test('adds every project, and skips one still loading', () => {
    const t = sumProjectCounts([
      counts({ runs: 2, running: 1, chats: 3, issues: 4 }),
      undefined,
      counts({ runs: 1, awaiting: 1, chats: 3, issues: 2 }),
    ]);
    expect(t).toEqual({ runs: 3, running: 1, awaiting: 1, chats: 6, issues: 6, issuesUnknown: 0 });
  });

  test('a project that cannot report issues is left out and counted, not taken as zero', () => {
    const t = sumProjectCounts([counts({ issues: null }), counts({ issues: 5 })]);
    expect(t.issues).toBe(5);
    expect(t.issuesUnknown).toBe(1);
  });

  test('no project able to report leaves the issue total unknown', () => {
    expect(sumProjectCounts([counts({ issues: null })]).issues).toBeNull();
    expect(sumProjectCounts([]).issues).toBeNull();
  });
});

describe('ProjectCountTotals', () => {
  test('renders the totals of the per-project entries, in runs/chats/issues order', () => {
    seed('pct-a', { runs: 1, running: 1, chats: 3, issues: 4 });
    seed('pct-b', { chats: 3, issues: null });
    const markup = renderToStaticMarkup(<ProjectCountTotals projectIds={['pct-a', 'pct-b']} />);
    expect(cells(markup)).toEqual(['1', '6', '4']);
    expect(markup).toContain('1 project could not report');
    expect(markup).toContain('cell live');
  });
});
