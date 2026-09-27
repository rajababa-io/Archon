/**
 * The composer's `/` menu: which entries a draft offers, in what order.
 *
 * Entries come from `GET /api/slash-commands`, which derives them from the
 * server's command registry, workflow discovery and the chat provider's own
 * listing — nothing here names a command. This module only groups and ranks
 * what the server sent against what was typed.
 */
import type { SlashCommandListing } from '../skills/slashCommands';

export interface SlashMenuEntry {
  /** Stable React key. */
  id: string;
  /** Text completing the entry puts in the composer. */
  insert: string;
  /** Command as shown, without arguments, e.g. `/workflow run`, `$imagegen`. */
  label: string;
  /** Argument synopsis, shown dimmed after the label. Empty when none. */
  args: string;
  description: string;
  kind: 'command' | 'workflow' | 'provider';
  /** Section heading the entry sits under in the unfiltered menu. */
  group: string;
  /** Short source tag shown at the end of the row; null for Archon's own commands. */
  tag: string | null;
}

type ProviderSection = NonNullable<SlashCommandListing['provider']>;
type ProviderEntry = ProviderSection['commands'][number];

/**
 * Sections for the provider's commands, in menu order. Headings and tags name
 * the provider the server reported — nothing here knows which one it is.
 */
function providerGroup(
  provider: ProviderSection,
  command: ProviderEntry
): { order: number; group: string; tag: string } {
  switch (command.origin) {
    case 'user':
      return { order: 0, group: 'Your skills and commands', tag: command.kind };
    case 'project':
      return { order: 1, group: 'Project', tag: 'project' };
    case 'provider':
      return command.kind === 'skill'
        ? { order: 2, group: `${provider.displayName} skills`, tag: provider.id }
        : { order: 3, group: provider.displayName, tag: provider.id };
    case 'other':
      return { order: 4, group: 'Plugins and other sources', tag: 'other' };
  }
}

/** A command that takes arguments completes with the space already typed. */
function insertFor(command: string, args: string): string {
  return args.length > 0 ? `${command} ` : command;
}

/**
 * Entries for one listing: Archon's commands in registry order, then the chat
 * provider's own commands grouped by where they come from, then workflows by
 * name.
 */
export function buildSlashEntries(listing: SlashCommandListing): SlashMenuEntry[] {
  const commands = listing.commands.map(
    (c): SlashMenuEntry => ({
      id: `command:${c.command}`,
      // The next keystroke is the argument, and the menu narrows to what
      // follows — `/workflow run ` lists the workflows.
      insert: insertFor(c.command, c.args),
      label: c.command,
      args: c.args,
      description: c.description,
      kind: 'command',
      group: 'Archon',
      tag: null,
    })
  );
  const provider = listing.provider;
  const providerEntries =
    provider === null
      ? []
      : provider.commands
          .map((c, index) => ({ c, index, ...providerGroup(provider, c) }))
          .sort((a, b) => a.order - b.order || a.index - b.index)
          .map(
            ({ c, group, tag }): SlashMenuEntry => ({
              id: `provider:${c.command}`,
              // A skill takes free text even when it declares no arguments.
              insert: c.kind === 'skill' ? `${c.command} ` : insertFor(c.command, c.args),
              label: c.command,
              args: c.args,
              description: c.description,
              kind: 'provider',
              group,
              tag,
            })
          );
  const workflows = [...listing.workflows]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (w): SlashMenuEntry => ({
        id: `workflow:${w.name}`,
        insert: `/workflow run ${w.name} `,
        label: `/workflow run ${w.name}`,
        args: '[message]',
        description: w.summary ?? 'Workflow',
        kind: 'workflow',
        group: 'Workflows',
        tag: 'workflow',
      })
    );
  return [...commands, ...providerEntries, ...workflows];
}

/**
 * Why the provider's commands are missing from the menu, or null when they
 * are not. A listing the provider could not answer must not read as complete.
 */
export function providerNotice(listing: SlashCommandListing | null): string | null {
  const provider = listing?.provider;
  if (provider?.error == null) return null;
  return `${provider.displayName} commands unavailable: ${provider.error}`;
}

/**
 * Lower is better; null is no match. Exact, then prefix, then a word prefix,
 * then word initials (`wr` → `workflow run`), then any in-order subsequence —
 * tighter subsequences first — so `/re` puts `/reset` above `/workflow resume`
 * and a stray letter scattered across a long workflow name sorts last.
 */
function score(label: string, query: string): number | null {
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  // `:` too, so `/status` finds a provider's clashing `/claude:status`.
  const words = label.split(/[\s:-]+/);
  if (words.some(w => w.startsWith(query))) return 2;
  if (
    words
      .map(w => w.charAt(0))
      .join('')
      .startsWith(query)
  )
    return 3;
  // Typed past the entry — its arguments, or a sentence — so it is no longer
  // a search for this entry.
  if (query.length > label.length) return null;
  let first = -1;
  let at = 0;
  for (const ch of query) {
    const found = label.indexOf(ch, at);
    if (found === -1) return null;
    if (first === -1) first = found;
    at = found + 1;
  }
  // 4 plus the fraction of the label the match spans: always behind the
  // ranks above, and a tight match beats a scattered one.
  return 4 + (at - first) / label.length;
}

/**
 * The entries a draft offers, best first; empty when the menu should stay
 * closed. The menu only answers a single-line draft that starts with `/` —
 * anything else is a message, and a message that happens to start with `/`
 * (a path, a fraction) matches nothing once it is a few words long, so it
 * sends exactly as it did before the menu existed.
 */
export function matchSlashEntries(
  entries: readonly SlashMenuEntry[],
  draft: string
): SlashMenuEntry[] {
  if (!draft.startsWith('/') || draft.includes('\n')) return [];
  const query = draft.slice(1).toLowerCase();
  const scored: { entry: SlashMenuEntry; rank: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const rank = score(entry.label.slice(1).toLowerCase(), query.trimEnd());
    if (rank !== null) scored.push({ entry, rank, index });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.index - b.index).map(s => s.entry);
}

/**
 * Whether Enter should complete the highlighted entry rather than send.
 * Once the draft already reads as that entry, Enter sends — so `/help` then
 * Enter runs /help, and completing never executes anything on its own.
 */
export function enterCompletes(entry: SlashMenuEntry, draft: string): boolean {
  return entry.insert.trimEnd() !== draft.trimEnd();
}
