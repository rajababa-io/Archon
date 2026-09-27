/**
 * Claude's own commands — built-ins, skills, user and project commands — as a
 * provider-neutral listing.
 *
 * Two SDK sources, because neither says everything:
 * - `supportedCommands()` carries each command's description, argument hint
 *   and `builtin` marker;
 * - the session's `init` message carries `skills` (which of those names are
 *   skills) and `terminal_slash_commands` (the ones whose UX needs a terminal).
 */
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderCommand, ProviderCommandListing } from '../types';

/** The parts of Claude's `init` system message the listing reads. */
export interface ClaudeInitCommandFields {
  skills?: readonly string[];
  terminal_slash_commands?: readonly string[];
}

/**
 * A command the CLI answers locally, without a model call. The listing sends it
 * so the session emits its `init` message — which is where
 * `terminal_slash_commands` and `skills` live — without billing a turn.
 * `supportedCommands()` alone never produces an `init`.
 */
export const CLAUDE_LOCAL_PROBE_COMMAND = '/context';

/** The reason recorded for a command Claude marks terminal-only. */
export const CLAUDE_TERMINAL_ONLY_REASON =
  'terminal-only (Claude marks it terminal_slash_commands)';

/**
 * Claude Code appends where a non-built-in command came from to its
 * description — ` (user)`, ` (project)`. It is the only place the SDK says so.
 * Read for grouping alone: a reworded or missing suffix leaves the command
 * listed and runnable, just grouped under `other`.
 */
const ORIGIN_SUFFIX = / \((user|project)\)$/;

function originOf(command: SlashCommand): {
  origin: ProviderCommand['origin'];
  description: string;
} {
  if (command.builtin === true) return { origin: 'provider', description: command.description };
  const match = ORIGIN_SUFFIX.exec(command.description);
  if (match === null) return { origin: 'other', description: command.description };
  return {
    origin: match[1] === 'user' ? 'user' : 'project',
    description: command.description.slice(0, match.index),
  };
}

/**
 * Translate what Claude reported into the provider-neutral listing. Every
 * reported command lands in exactly one of `commands` and `withheld`.
 * A command name reported twice (a built-in and a user command can share
 * one) is listed once, as the row `/name` runs — the built-in, per the SDK's
 * `builtin` doc.
 */
export function toClaudeCommandListing(
  supported: readonly SlashCommand[],
  init: ClaudeInitCommandFields | undefined
): ProviderCommandListing {
  const skills = new Set(init?.skills ?? []);
  const terminalOnly = new Set(init?.terminal_slash_commands ?? []);
  const byName = new Map<string, SlashCommand>();
  for (const command of supported) {
    const existing = byName.get(command.name);
    if (existing === undefined || (command.builtin === true && existing.builtin !== true)) {
      byName.set(command.name, command);
    }
  }

  const listing: ProviderCommandListing = { commands: [], withheld: [] };
  for (const command of byName.values()) {
    if (terminalOnly.has(command.name)) {
      listing.withheld.push({ name: command.name, reason: CLAUDE_TERMINAL_ONLY_REASON });
      continue;
    }
    const { origin, description } = originOf(command);
    listing.commands.push({
      name: command.name,
      sigil: '/',
      args: command.argumentHint,
      description,
      kind: skills.has(command.name) ? 'skill' : 'command',
      origin,
    });
  }
  return listing;
}

/** The prompt that runs `name` as a Claude slash command. */
export function claudeCommandPrompt(name: string, args: string): string {
  return args.length > 0 ? `/${name} ${args}` : `/${name}`;
}
