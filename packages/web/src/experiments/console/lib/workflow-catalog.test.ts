import { describe, expect, test } from 'bun:test';
import { buildCatalog, summarize } from './workflow-catalog';
import type { Workflow } from '../primitives/workflow';
import type { Run } from '../primitives/run';

function wf(name: string, source: string, description: string | null = null): Workflow {
  return { name, source, description, parseWarnings: [], inputs: [] };
}

function run(workflow: string, status: Run['status'], startedAt: string): Run {
  return { workflow, status, startedAt } as Run;
}

describe('summarize', () => {
  test('takes the first sentence after "Use when:"', () => {
    expect(summarize('Use when: A thing needs doing. More here.\nDoes: stuff')).toBe(
      'A thing needs doing.'
    );
  });

  test('falls back to the first line', () => {
    expect(summarize('Smoke test for Claude provider.\nSecond line')).toBe(
      'Smoke test for Claude provider.'
    );
  });

  test('empty for no description', () => {
    expect(summarize(null)).toBe('');
  });
});

describe('buildCatalog', () => {
  const workflows = [
    wf('b-proj', 'project'),
    wf('a-proj', 'project'),
    wf('ship', 'bundled'),
    wf('plan', 'bundled'),
    wf('home', 'global'),
    wf('odd', 'something-new'),
  ];
  const runs = [
    run('plan', 'completed', '2026-09-01T00:00:00Z'),
    run('ship', 'failed', '2026-09-20T00:00:00Z'),
    run('ship', 'completed', '2026-09-10T00:00:00Z'),
  ];
  const groups = buildCatalog(workflows, { ship: 46, plan: 1 }, runs);

  test('workflows that have run come first, newest run first, and appear once', () => {
    expect(groups[0]?.id).toBe('recent');
    expect(groups[0]?.rows.map(r => r.name)).toEqual(['ship', 'plan']);
    const all = groups.flatMap(g => g.rows.map(r => r.name));
    expect(all.filter(n => n === 'ship')).toHaveLength(1);
  });

  test('the last run is the newest one, and runs are counted', () => {
    const ship = groups[0]?.rows[0];
    expect(ship?.lastStatus).toBe('failed');
    expect(ship?.runs).toBe(2);
    expect(ship?.steps).toBe(46);
  });

  test('the rest group by source, alphabetically; an unknown source is not dropped', () => {
    expect(groups.map(g => g.id)).toEqual(['recent', 'project', 'global']);
    expect(groups[1]?.rows.map(r => r.name)).toEqual(['a-proj', 'b-proj', 'odd']);
    expect(groups[2]?.rows.map(r => r.name)).toEqual(['home']);
  });

  test('a workflow with no step count shows zero rather than failing', () => {
    expect(groups[1]?.rows[0]?.steps).toBe(0);
  });
});
