/**
 * Codex's commands as a provider-neutral listing: the skills `skills/list`
 * reports, plus the Codex actions this provider runs through app-server.
 */
import type { ProviderCommand, ProviderCommandListing } from '../types';
import type { CodexSkillMetadata } from './app-server';

/**
 * Codex's own actions that this provider implements (see `runCodexAppServerTurn`).
 * Not discoverable from Codex — they are app-server methods, not listed
 * commands — so the provider declares the ones it can run.
 */
export const CODEX_ACTIONS = [
  {
    name: 'compact',
    sigil: '/',
    args: '',
    description: 'Summarize the conversation so far to free up context',
    kind: 'command',
    origin: 'provider',
  },
  {
    name: 'review',
    sigil: '/',
    args: '[instructions]',
    description: 'Review the uncommitted changes, or what the instructions name',
    kind: 'command',
    origin: 'provider',
  },
] as const satisfies readonly ProviderCommand[];

export type CodexActionName = (typeof CODEX_ACTIONS)[number]['name'];

export function isCodexAction(name: string): name is CodexActionName {
  return CODEX_ACTIONS.some(a => a.name === name);
}

const SCOPE_ORIGIN: Record<CodexSkillMetadata['scope'], ProviderCommand['origin']> = {
  system: 'provider',
  user: 'user',
  repo: 'project',
  admin: 'other',
};

export const CODEX_DISABLED_SKILL_REASON = 'disabled in Codex configuration';

/** Codex spells a skill invocation as a `$name` mention. */
export function toCodexCommandListing(
  skills: readonly CodexSkillMetadata[]
): ProviderCommandListing {
  const listing: ProviderCommandListing = { commands: [...CODEX_ACTIONS], withheld: [] };
  for (const skill of skills) {
    if (!skill.enabled) {
      listing.withheld.push({ name: skill.name, reason: CODEX_DISABLED_SKILL_REASON });
      continue;
    }
    listing.commands.push({
      name: skill.name,
      sigil: '$',
      args: '',
      description: skill.shortDescription ?? skill.description,
      kind: 'skill',
      // An unknown future scope still lists the skill, grouped as `other`.
      origin: SCOPE_ORIGIN[skill.scope] ?? 'other',
    });
  }
  return listing;
}

/** The prompt that invokes a Codex skill: a `$name` mention, then the arguments. */
export function codexSkillPrompt(name: string, args: string): string {
  return args.length > 0 ? `$${name} ${args}` : `$${name}`;
}
