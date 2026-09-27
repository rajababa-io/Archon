/**
 * Which folder a chat's agent edits, on which branch, and whether it holds
 * uncommitted work — read from git each time it is asked.
 *
 * Read rather than stored because none of it is the conversation's to know: the
 * agent commits, switches branch, or leaves files behind mid-turn without the
 * row changing. The folder is the one the orchestrator hands the chat's turns
 * (`conversation.cwd`, else the project's registered checkout), so the answer
 * describes where the next turn will run, not where the page thinks it will.
 */
import { resolve } from 'path';
import { getGitCheckoutIdentity, readCheckoutStatus, toRepoPath } from '@archon/git';
import { createLogger } from '@archon/paths';

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
}

const UNKNOWN: ConversationCheckout = { path: null, location: null, branch: null, dirty: null };

/** The git reads this needs, injectable so tests do not shell out. */
export interface CheckoutGit {
  readCheckoutStatus: typeof readCheckoutStatus;
  getGitCheckoutIdentity: typeof getGitCheckoutIdentity;
}

const defaultGit: CheckoutGit = { readCheckoutStatus, getGitCheckoutIdentity };

/**
 * Every field that cannot be read is null, never a default. A failed
 * `git status` is not a clean tree and a failed identity read is not the live
 * checkout; the console hides what it is not told.
 */
export async function readConversationCheckout(
  conversation: { cwd: string | null },
  codebase: { default_cwd: string } | null,
  git: CheckoutGit = defaultGit
): Promise<ConversationCheckout> {
  // No project: the orchestrator runs the chat in Archon's own workspaces
  // folder, which has no branch worth naming.
  if (codebase === null) return UNKNOWN;
  const path = conversation.cwd ?? codebase.default_cwd;

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

  return {
    path,
    location,
    branch: status.status === 'fulfilled' ? status.value.branch : null,
    dirty: status.status === 'fulfilled' ? status.value.dirty : null,
  };
}
