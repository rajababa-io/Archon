import { describe, expect, test } from 'bun:test';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import {
  CLAUDE_TERMINAL_ONLY_REASON,
  claudeCommandPrompt,
  toClaudeCommandListing,
} from './commands';

// Shapes as Claude Code 0.3.x reported them for a real project (2026-09-27).
const reported: SlashCommand[] = [
  {
    name: 'compact',
    description: 'Free up context by summarizing the conversation so far',
    argumentHint: '<optional custom summarization instructions>',
    builtin: true,
  },
  { name: 'simplify', description: 'Review the changed code', argumentHint: '', builtin: true },
  {
    name: 'color',
    description: 'Set the prompt bar color',
    argumentHint: '[red|…]',
    builtin: true,
  },
  { name: 'visual', description: 'Generate polished diagrams (user)', argumentHint: '' },
  { name: 'validate', description: "Run Archon's validation suite (project)", argumentHint: '' },
  {
    name: 'github_bug_fix:rca',
    description: 'Analyze root cause (project)',
    argumentHint: '[github-issue-id]',
  },
  { name: 'mcp__docs__search', description: 'Search the docs', argumentHint: '' },
];
const init = { skills: ['simplify', 'visual'], terminal_slash_commands: ['color'] };

describe('toClaudeCommandListing', () => {
  // The conformance half of #149: every command Claude reports is either
  // offered or withheld with Claude's own reason — none silently dropped.
  test('accounts for every reported command', () => {
    const listing = toClaudeCommandListing(reported, init);
    const accounted = [
      ...listing.commands.map(c => c.name),
      ...listing.withheld.map(w => w.name),
    ].sort();
    expect(accounted).toEqual(reported.map(c => c.name).sort());
    expect(listing.withheld).toEqual([{ name: 'color', reason: CLAUDE_TERMINAL_ONLY_REASON }]);
  });

  test('groups by where each command comes from and strips the origin suffix', () => {
    const byName = new Map(toClaudeCommandListing(reported, init).commands.map(c => [c.name, c]));
    expect(byName.get('compact')).toMatchObject({
      origin: 'provider',
      kind: 'command',
      sigil: '/',
    });
    expect(byName.get('simplify')).toMatchObject({ origin: 'provider', kind: 'skill' });
    expect(byName.get('visual')).toMatchObject({
      origin: 'user',
      kind: 'skill',
      description: 'Generate polished diagrams',
    });
    expect(byName.get('github_bug_fix:rca')).toMatchObject({
      origin: 'project',
      kind: 'command',
      args: '[github-issue-id]',
    });
    // No suffix: still listed and runnable, grouped as `other`.
    expect(byName.get('mcp__docs__search')?.origin).toBe('other');
  });

  test('without an init message nothing is withheld and nothing is a skill', () => {
    const listing = toClaudeCommandListing(reported, undefined);
    expect(listing.withheld).toEqual([]);
    expect(listing.commands).toHaveLength(reported.length);
    expect(listing.commands.every(c => c.kind === 'command')).toBe(true);
  });

  test('a name reported twice is listed once, as the built-in /name runs', () => {
    const listing = toClaudeCommandListing(
      [
        { name: 'review', description: 'Mine (user)', argumentHint: '' },
        { name: 'review', description: 'Built in', argumentHint: '', builtin: true },
      ],
      undefined
    );
    expect(listing.commands).toEqual([
      expect.objectContaining({ name: 'review', origin: 'provider', description: 'Built in' }),
    ]);
  });
});

test('claudeCommandPrompt sends the bare slash command', () => {
  expect(claudeCommandPrompt('compact', '')).toBe('/compact');
  expect(claudeCommandPrompt('status', 'brief please')).toBe('/status brief please');
});
