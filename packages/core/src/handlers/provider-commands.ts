/**
 * The chat provider's own commands — what the `/` menu lists after Archon's
 * commands, and what a chat message is recognised as before it is sent.
 *
 * Provider-neutral: every name comes from the provider's `listCommands()`.
 * This module only decides how each is spelled in Archon (Archon's own
 * commands keep their names; a provider command that clashes gets a
 * provider-prefixed spelling) and keeps a short-lived cache, because listing
 * starts a provider subprocess.
 */
import type {
  IAgentProvider,
  ListCommandsOptions,
  ProviderCommand,
  ProviderCommandInvocation,
} from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import { findSlashCommand, INLINE_COMMAND_NAMES } from './command-registry';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider-commands');
  return cachedLog;
}

/** A provider command as a chat spells it. */
export interface ChatProviderCommand extends ProviderCommand {
  /** What the user types to run it, e.g. `/compact`, `$imagegen`, `/claude:status`. */
  invocation: string;
}

export interface ChatProviderCommandListing {
  commands: ChatProviderCommand[];
  withheld: { name: string; reason: string }[];
}

/** Whether Archon itself answers `/name` — the registry, plus commands the orchestrator handles inline. */
function archonOwns(name: string): boolean {
  return (
    findSlashCommand(name) !== undefined ||
    (INLINE_COMMAND_NAMES as readonly string[]).includes(name)
  );
}

/**
 * How a chat spells each command. Archon's own commands win a name clash
 * (`/status` stays Archon's); the provider's command is then reachable as
 * `/<provider>:<name>`, which Archon translates back to the provider's name.
 * A provider name that already has that exact spelling keeps it, and the
 * clashing command then has no spelling — it is logged, never guessed.
 */
export function spellProviderCommands(
  providerKey: string,
  commands: readonly ProviderCommand[]
): ChatProviderCommand[] {
  const taken = new Set(commands.map(c => `${c.sigil}${c.name}`));
  const spelled: ChatProviderCommand[] = [];
  for (const command of commands) {
    let invocation = `${command.sigil}${command.name}`;
    if (command.sigil === '/' && archonOwns(command.name)) {
      const alias = `/${providerKey}:${command.name}`;
      if (taken.has(alias)) {
        getLog().warn({ providerKey, name: command.name }, 'provider_commands.clash_unspellable');
        continue;
      }
      invocation = alias;
    }
    spelled.push({ ...command, invocation });
  }
  return spelled;
}

/**
 * The command a chat message runs, or undefined when the message is ordinary
 * text. Only an exact invocation as the first word matches, so a message that
 * starts with `/` by accident — a path, a fraction — stays a message.
 */
export function matchProviderCommand(
  message: string,
  commands: readonly ChatProviderCommand[]
): { command: ChatProviderCommand; invocation: ProviderCommandInvocation } | undefined {
  const trimmed = message.trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) return undefined;
  const command = commands.find(c => c.invocation === match[1]);
  if (command === undefined) return undefined;
  return { command, invocation: { name: command.name, args: (match[2] ?? '').trim() } };
}

/** How long a listing is reused. Skills installed meanwhile appear after this. */
const LISTING_TTL_MS = 5 * 60_000;

const listingCache = new Map<
  string,
  { at: number; listing: Promise<ChatProviderCommandListing> }
>();

/** Clear the listing cache. Exported for tests. */
export function clearProviderCommandCache(): void {
  listingCache.clear();
}

/**
 * The provider's commands for a chat in `cwd`, cached per provider and
 * directory. A provider without `listCommands` offers none. A failed listing
 * is not cached, so the next request tries again.
 */
export function listProviderCommands(
  providerKey: string,
  provider: IAgentProvider,
  cwd: string,
  options?: ListCommandsOptions
): Promise<ChatProviderCommandListing> {
  if (provider.listCommands === undefined) {
    return Promise.resolve({ commands: [], withheld: [] });
  }
  const key = `${providerKey}\u0000${cwd}`;
  const hit = listingCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < LISTING_TTL_MS) return hit.listing;

  const listing = provider.listCommands(cwd, options).then(raw => ({
    commands: spellProviderCommands(providerKey, raw.commands),
    withheld: raw.withheld,
  }));
  listingCache.set(key, { at: Date.now(), listing });
  listing.catch((err: unknown) => {
    if (listingCache.get(key)?.listing === listing) listingCache.delete(key);
    getLog().warn({ err, providerKey, cwd }, 'provider_commands.list_failed');
  });
  return listing;
}
