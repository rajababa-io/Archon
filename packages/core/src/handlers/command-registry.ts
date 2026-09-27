/**
 * The slash commands the server answers deterministically, without an AI turn.
 *
 * This list is the owner. The orchestrator's "is this a command" gate, the
 * command handler's dispatch, its help and usage text, and the `/api/commands`
 * listing the console's `/` menu reads all derive from it. The dispatch
 * switches narrow to the names declared here and end in an exhaustive `never`,
 * so a command added here without a handler — or a handler for a name missing
 * here — fails to compile instead of drifting.
 */

/**
 * `handler` — dispatched by `handleCommand`.
 * `orchestrator` — dispatched by the orchestrator itself, because it needs the
 * platform or the raw message rather than a parsed conversation command.
 */
export type SlashCommandOwner = 'handler' | 'orchestrator';

export interface SlashCommandSpec {
  readonly name: string;
  /** Argument synopsis as shown in help, e.g. `<name> <path>`. Empty when none. */
  readonly args: string;
  /** One line, shown in help and in the console menu. */
  readonly description: string;
  readonly owner: SlashCommandOwner;
  /** Second words the command takes, each listed in help and in the console menu. */
  readonly subcommands?: readonly SlashSubcommandSpec[];
}

export interface SlashSubcommandSpec {
  readonly name: string;
  readonly args: string;
  readonly description: string;
  /** Other spellings the dispatch accepts. Not listed in help or the menu. */
  readonly aliases?: readonly string[];
}

export const WORKFLOW_SUBCOMMANDS = [
  { name: 'list', args: '', description: 'List available workflows', aliases: ['ls'] },
  { name: 'run', args: '<name> [message]', description: 'Run a workflow directly' },
  { name: 'status', args: '', description: 'Show all active workflows' },
  {
    name: 'cancel',
    args: '[id]',
    description: 'Cancel a running workflow (default: the one in this conversation)',
  },
  { name: 'resume', args: '<id>', description: 'Resume a failed or paused run' },
  { name: 'abandon', args: '<id>', description: 'Abandon a running, failed, or paused run' },
  { name: 'approve', args: '<id> [comment]', description: 'Approve a paused gate' },
  { name: 'reject', args: '<id> [reason]', description: 'Reject a paused gate' },
  {
    name: 'respond',
    args: '<id> <decision> [text]',
    description: 'Answer a paused gate with one of its declared decisions',
  },
  {
    name: 'reset-sessions',
    args: '<name> [<node-id>]',
    description: 'Clear persisted AI session memory for this conversation',
  },
  { name: 'reload', args: '', description: 'Reload workflow definitions' },
] as const satisfies readonly SlashSubcommandSpec[];

export const WORKTREE_SUBCOMMANDS = [
  { name: 'create', args: '<branch>', description: 'Create a worktree for this conversation' },
  { name: 'list', args: '', description: "List the project's worktrees" },
  { name: 'remove', args: '[--force]', description: "Remove this conversation's worktree" },
  {
    name: 'live',
    args: '',
    description: "Work in the project's live checkout, shared with other chats",
  },
  {
    name: 'cleanup',
    args: 'merged|stale',
    description: 'Remove merged or stale worktrees',
  },
  {
    name: 'orphans',
    args: '',
    description: 'List every git worktree, including ones Archon did not create',
  },
] as const satisfies readonly SlashSubcommandSpec[];

export const SLASH_COMMANDS = [
  { name: 'help', args: '', description: 'Show this help message', owner: 'handler' },
  {
    name: 'status',
    args: '',
    description: 'Show current session and project info',
    owner: 'handler',
  },
  {
    name: 'reset',
    args: '',
    description: 'Clear the conversation and start fresh',
    owner: 'handler',
  },
  {
    name: 'workflow',
    args: '<subcommand>',
    description: 'List, run, and manage workflow runs',
    owner: 'handler',
    subcommands: WORKFLOW_SUBCOMMANDS,
  },
  {
    name: 'worktree',
    args: '<subcommand>',
    description: "Manage this conversation's git worktree",
    owner: 'handler',
    subcommands: WORKTREE_SUBCOMMANDS,
  },
  {
    name: 'commands',
    args: '',
    description: "List the project's .archon/commands",
    owner: 'handler',
  },
  {
    name: 'init',
    args: '',
    description: 'Create a .archon folder in the project',
    owner: 'handler',
  },
  {
    name: 'register-project',
    args: '<name> <path>',
    description: 'Register a local project',
    owner: 'orchestrator',
  },
  {
    name: 'update-project',
    args: '<name> <new-path>',
    description: "Update a project's path",
    owner: 'orchestrator',
  },
  {
    name: 'remove-project',
    args: '<name>',
    description: 'Remove a registered project',
    owner: 'orchestrator',
  },
  {
    name: 'setproject',
    args: '<name>',
    description: 'Bind this conversation to a registered project',
    owner: 'orchestrator',
  },
] as const satisfies readonly SlashCommandSpec[];

/**
 * Commands the orchestrator answers inline, mid-turn, because they need state
 * only a resolved chat turn has (`/retitle` needs the small tier and the
 * sender's credentials). Not dispatched from the registry, but still Archon's
 * names: a provider command with one of them gets a prefixed spelling.
 */
export const INLINE_COMMAND_NAMES = ['retitle'] as const;

export type SlashCommandName = (typeof SLASH_COMMANDS)[number]['name'];
export type HandlerCommandName = Extract<
  (typeof SLASH_COMMANDS)[number],
  { owner: 'handler' }
>['name'];
export type OrchestratorCommandName = Exclude<SlashCommandName, HandlerCommandName>;
export type WorkflowSubcommandName = (typeof WORKFLOW_SUBCOMMANDS)[number]['name'];
export type WorktreeSubcommandName = (typeof WORKTREE_SUBCOMMANDS)[number]['name'];

function findSpec<T extends { readonly name: string; readonly aliases?: readonly string[] }>(
  specs: readonly T[],
  word: string | undefined
): T | undefined {
  if (word === undefined) return undefined;
  return specs.find(s => s.name === word || (s.aliases?.includes(word) ?? false));
}

/** The registered command a parsed command word names, or undefined. */
export function findSlashCommand(command: string): (typeof SLASH_COMMANDS)[number] | undefined {
  return findSpec(SLASH_COMMANDS, command);
}

/** Canonical workflow subcommand for a typed word (aliases resolved), or undefined. */
export function resolveWorkflowSubcommand(
  word: string | undefined
): WorkflowSubcommandName | undefined {
  return findSpec(WORKFLOW_SUBCOMMANDS, word)?.name;
}

export function resolveWorktreeSubcommand(
  word: string | undefined
): WorktreeSubcommandName | undefined {
  return findSpec(WORKTREE_SUBCOMMANDS, word)?.name;
}

/** `<name> <args>` for a usage line, without a trailing space when there are no args. */
export function commandSynopsis(spec: { readonly name: string; readonly args: string }): string {
  return spec.args.length > 0 ? `${spec.name} ${spec.args}` : spec.name;
}
