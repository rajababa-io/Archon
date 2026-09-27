import { describe, expect, test } from 'bun:test';
import { buildSlashEntries, enterCompletes, matchSlashEntries } from './slash-menu';

const entries = buildSlashEntries({
  commands: [
    { command: '/help', args: '', description: 'Show this help message' },
    { command: '/reset', args: '', description: 'Clear the conversation' },
    { command: '/workflow', args: '<subcommand>', description: 'Manage workflow runs' },
    { command: '/workflow run', args: '<name> [message]', description: 'Run a workflow' },
    { command: '/workflow resume', args: '<id>', description: 'Resume a run' },
  ],
  workflows: [
    { name: 'archon-plan', summary: 'Plan a change' },
    { name: 'archon-assist', summary: null },
  ],
});

const labels = (draft: string): string[] => matchSlashEntries(entries, draft).map(e => e.label);

describe('buildSlashEntries', () => {
  test('a command with arguments completes with the space already typed', () => {
    const run = entries.find(e => e.label === '/workflow run');
    const help = entries.find(e => e.label === '/help');
    expect(run?.insert).toBe('/workflow run ');
    expect(help?.insert).toBe('/help');
  });

  test('workflows complete to a run command, sorted by name, after the commands', () => {
    const workflows = entries.filter(e => e.kind === 'workflow');
    expect(workflows.map(e => e.insert)).toEqual([
      '/workflow run archon-assist ',
      '/workflow run archon-plan ',
    ]);
    expect(entries.at(-1)?.kind).toBe('workflow');
    expect(workflows[0]?.description).toBe('Workflow');
  });
});

describe('matchSlashEntries', () => {
  test('a bare slash offers everything, in listing order', () => {
    expect(labels('/')).toHaveLength(entries.length);
    expect(labels('/')[0]).toBe('/help');
  });

  test('prefix beats a word inside, which beats a fuzzy subsequence', () => {
    expect(labels('/re')[0]).toBe('/reset');
    expect(labels('/re')).toContain('/workflow resume');
    expect(labels('/wr')[0]).toBe('/workflow run');
    expect(labels('/wfrs')[0]).toBe('/workflow resume');
    expect(labels('/zzz')).toEqual([]);
  });

  test('typing past a command narrows to what follows it', () => {
    expect(labels('/workflow run ')).toEqual([
      '/workflow run',
      '/workflow run archon-assist',
      '/workflow run archon-plan',
    ]);
    expect(labels('/workflow run archon-p')).toEqual(['/workflow run archon-plan']);
  });

  test('a tight fuzzy match beats one scattered across a long name', () => {
    expect(labels('/workflow aplan')[0]).toBe('/workflow run archon-plan');
  });

  test('arguments close the menu', () => {
    expect(labels('/workflow run archon-plan fix the login bug')).toEqual([]);
    expect(labels('/workflow resume 3f2a91cc')).toEqual([]);
  });

  // The invariant from #129: a message that starts with `/` by accident still
  // sends as it did before the menu existed.
  test('ordinary messages open nothing', () => {
    expect(labels('hello')).toEqual([]);
    expect(labels('/etc/hosts has a stale entry for the build box')).toEqual([]);
    expect(labels('/help\nand more')).toEqual([]);
  });
});

describe('enterCompletes', () => {
  const find = (label: string) => {
    const entry = entries.find(e => e.label === label);
    if (entry === undefined) throw new Error(label);
    return entry;
  };

  test('completes a partial command', () => {
    expect(enterCompletes(find('/help'), '/he')).toBe(true);
  });

  test('sends once the draft already reads as the entry', () => {
    expect(enterCompletes(find('/help'), '/help')).toBe(false);
    expect(enterCompletes(find('/workflow run archon-plan'), '/workflow run archon-plan ')).toBe(
      false
    );
  });
});
