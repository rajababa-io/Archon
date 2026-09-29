/**
 * Which folder a chat's agent edits, on which branch, and whether it holds
 * uncommitted work that is not already on the base branch — read from git
 * each time it is asked.
 *
 * Read rather than stored because none of it is the conversation's to know: the
 * agent commits, switches branch, or leaves files behind mid-turn without the
 * row changing. The folder is the one the orchestrator hands the chat's turns
 * (`conversation.cwd`, else the project's registered checkout), so the answer
 * describes where the next turn will run, not where the page thinks it will.
 */
import { resolve } from 'path';
import {
  countChangesOffBase,
  getDefaultBranch,
  getGitCheckoutIdentity,
  readCheckoutStatus,
  toRepoPath,
} from '@archon/git';
import { createLogger } from '@archon/paths';
import { loadRepoConfig } from '@archon/core';
import { conversationCheckout } from '@archon/core/utils/conversation-checkout';

/** Lazy — a module-level logger would capture the level before tests set it. */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('conversation-checkout');
  return cachedLog;
}

export interface ConversationCheckout {
  /** The folder the chat's turns run in, or null when it is not a project. */
  path: string | null;
  /**
   * `live` — the project's own registered checkout, the folder a person works
   * in. `worktree` — a separate linked worktree. Null when the folder is
   * neither, or git could not say.
   */
  location: 'live' | 'worktree' | null;
  /** The checked-out branch; null on a detached HEAD or when git could not say. */
  branch: string | null;
  /** Whether anything is modified, staged, or untracked; null when unreadable. */
  dirty: boolean | null;
  /** The branch `offBaseFiles` compares with; null when it could not be resolved. */
  baseBranch: string | null;
  /**
   * Changed files holding content that is on no copy of the base branch — the
   * work a reset of this folder would lose. Zero for a clean tree; null when
   * the status or the comparison could not be read.
   */
  offBaseFiles: number | null;
}

const UNKNOWN: ConversationCheckout = {
  path: null,
  location: null,
  branch: null,
  dirty: null,
  baseBranch: null,
  offBaseFiles: null,
};

/** The project fields the checkout read uses. */
export interface CheckoutCodebase {
  default_cwd: string;
  default_branch?: string | null;
}

/** The git reads this needs, injectable so tests do not shell out. */
export interface CheckoutGit {
  readCheckoutStatus: typeof readCheckoutStatus;
  getGitCheckoutIdentity: typeof getGitCheckoutIdentity;
  countChangesOffBase: typeof countChangesOffBase;
  resolveBaseBranch: (path: string, codebase: CheckoutCodebase) => Promise<string>;
}

/**
 * The base branch the rest of Archon cuts work from: the repo config's
 * `worktree.baseBranch` wins over the project's recorded default branch, as in
 * the orchestrator; with neither, the remote's HEAD, as in cleanup.
 */
async function resolveBaseBranch(path: string, codebase: CheckoutCodebase): Promise<string> {
  const config = await loadRepoConfig(path);
  const configured = config.worktree?.baseBranch?.trim();
  if (configured) return configured;
  const recorded = codebase.default_branch?.trim();
  if (recorded) return recorded;
  return getDefaultBranch(toRepoPath(path), config.worktree?.remote?.trim() || 'origin');
}

const defaultGit: CheckoutGit = {
  readCheckoutStatus,
  getGitCheckoutIdentity,
  countChangesOffBase,
  resolveBaseBranch,
};

/**
 * Resolve the base branch and count what is off it. Only asked for a dirty
 * tree: a clean one has nothing to lose whatever the base is.
 */
async function readOffBase(
  path: string,
  codebase: CheckoutCodebase,
  git: CheckoutGit
): Promise<Pick<ConversationCheckout, 'baseBranch' | 'offBaseFiles'>> {
  let baseBranch: string | null = null;
  try {
    baseBranch = await git.resolveBaseBranch(path, codebase);
    return { baseBranch, offBaseFiles: await git.countChangesOffBase(path, baseBranch) };
  } catch (err) {
    getLog().debug({ path, baseBranch, err: err as Error }, 'checkout_off_base_unreadable');
    return { baseBranch, offBaseFiles: null };
  }
}

/**
 * Every field that cannot be read is null, never a default. A failed
 * `git status` is not a clean tree and a failed identity read is not the live
 * checkout; the console hides what it is not told.
 */
export async function readConversationCheckout(
  conversation: { cwd: string | null },
  codebase: CheckoutCodebase | null,
  git: CheckoutGit = defaultGit
): Promise<ConversationCheckout> {
  // No project: the orchestrator runs the chat in Archon's own workspaces
  // folder, which has no branch worth naming. The folder rule itself is
  // `conversationCheckout`, the one the orchestrator's turn uses.
  const path = conversationCheckout(conversation, codebase ?? undefined);
  if (path === null || codebase === null) return UNKNOWN;

  const [status, identity] = await Promise.allSettled([
    git.readCheckoutStatus(toRepoPath(path)),
    // Only asked when the folder is not the project's own — equality already
    // answers `live`, and needs no git call.
    resolve(path) === resolve(codebase.default_cwd)
      ? Promise.resolve(null)
      : git.getGitCheckoutIdentity(path),
  ]);

  if (status.status === 'rejected') {
    getLog().debug({ path, err: status.reason as Error }, 'checkout_status_unreadable');
  }
  if (identity.status === 'rejected') {
    getLog().debug({ path, err: identity.reason as Error }, 'checkout_identity_unreadable');
  }

  let location: ConversationCheckout['location'] = null;
  if (identity.status === 'fulfilled') {
    location = identity.value === null ? 'live' : identity.value.linkedWorktree ? 'worktree' : null;
  }

  const dirty = status.status === 'fulfilled' ? status.value.dirty : null;
  const offBase: Pick<ConversationCheckout, 'baseBranch' | 'offBaseFiles'> =
    dirty === true
      ? await readOffBase(path, codebase, git)
      : { baseBranch: null, offBaseFiles: dirty === false ? 0 : null };

  return {
    path,
    location,
    branch: status.status === 'fulfilled' ? status.value.branch : null,
    dirty,
    ...offBase,
  };
}
