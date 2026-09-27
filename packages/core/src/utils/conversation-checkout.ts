/**
 * The directory a chat's agent turn runs in, when the chat is scoped to a
 * project: the conversation's own `cwd` override (a worktree it was bound
 * to) if it has one, otherwise the project's checkout.
 *
 * One function because every reader must agree on it: the orchestrator, which
 * starts the turn there, and the console's status line and Changes panel,
 * which describe that folder. A reader that computed its own answer could
 * describe a different tree than the one the agent edits.
 *
 * Returns null for an unscoped chat. The orchestrator then runs in the
 * workspaces root, which is not one checkout and has no changes to show.
 */
export function conversationCheckout(
  conversation: { cwd: string | null },
  codebase: { default_cwd: string } | undefined
): string | null {
  if (codebase === undefined) return null;
  return conversation.cwd ?? codebase.default_cwd;
}
