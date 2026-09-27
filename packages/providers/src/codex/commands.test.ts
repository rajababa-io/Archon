import { describe, expect, test } from 'bun:test';
import type { CodexSkillMetadata } from './app-server';
import {
  CODEX_ACTIONS,
  CODEX_DISABLED_SKILL_REASON,
  codexSkillPrompt,
  isCodexAction,
  toCodexCommandListing,
} from './commands';

// Shapes as `codex app-server` skills/list reported them (codex-cli 0.151).
const skills: CodexSkillMetadata[] = [
  {
    name: 'imagegen',
    description: 'Generate or edit raster images',
    scope: 'system',
    enabled: true,
  },
  {
    name: 'review-agent',
    description: 'Long form',
    shortDescription: 'Find actionable bugs',
    scope: 'system',
    enabled: true,
  },
  { name: 'mine', description: 'A user skill', scope: 'user', enabled: true },
  { name: 'repo-thing', description: 'A repo skill', scope: 'repo', enabled: true },
  { name: 'off', description: 'Turned off', scope: 'user', enabled: false },
];

describe('toCodexCommandListing', () => {
  // The conformance half of #149: every skill Codex reports is offered as
  // `$name` or withheld with a reason — none silently dropped.
  test('accounts for every reported skill, and offers the Codex actions', () => {
    const listing = toCodexCommandListing(skills);
    const skillNames = listing.commands.filter(c => c.sigil === '$').map(c => c.name);
    const accounted = [...skillNames, ...listing.withheld.map(w => w.name)].sort();
    expect(accounted).toEqual(skills.map(s => s.name).sort());
    expect(listing.withheld).toEqual([{ name: 'off', reason: CODEX_DISABLED_SKILL_REASON }]);
    for (const action of CODEX_ACTIONS) {
      expect(listing.commands).toContainEqual(action);
    }
  });

  test('maps scope to origin and prefers the short description', () => {
    const byName = new Map(toCodexCommandListing(skills).commands.map(c => [c.name, c]));
    expect(byName.get('imagegen')).toMatchObject({ origin: 'provider', kind: 'skill', sigil: '$' });
    expect(byName.get('review-agent')?.description).toBe('Find actionable bugs');
    expect(byName.get('mine')?.origin).toBe('user');
    expect(byName.get('repo-thing')?.origin).toBe('project');
  });
});

test('a skill runs as a $name mention; compact and review are actions', () => {
  expect(codexSkillPrompt('imagegen', 'a red fox')).toBe('$imagegen a red fox');
  expect(codexSkillPrompt('imagegen', '')).toBe('$imagegen');
  expect(isCodexAction('compact')).toBe(true);
  expect(isCodexAction('review')).toBe(true);
  expect(isCodexAction('imagegen')).toBe(false);
});
