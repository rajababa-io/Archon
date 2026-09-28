/**
 * Which push preference governs a chat. The server decides what to push with
 * it, and the phone's bell shows its answer, so the bell cannot say "muted"
 * about a chat the server would still notify for, or the reverse.
 *
 * Generic over the mode, because the modes are the database's (`NOTIFY_MODES`
 * in `@archon/core`) and the phone reads them from the generated API types;
 * this package owns only the precedence.
 */

/**
 * A chat's effective mode, most specific first: the chat's own mode unless it
 * is `default`, then a project mute, then `default`.
 */
export function resolveChatMode<Own extends string>(
  prefs: {
    /** Chats with a mode of their own. Absent is `default`. */
    conversations: Readonly<Partial<Record<string, Own>>>;
    mutedProjects: readonly string[];
  },
  chatId: string | null,
  projectId: string | null
): Own | 'muted' | 'default' {
  const own = chatId === null ? undefined : prefs.conversations[chatId];
  if (own !== undefined) return own;
  if (projectId !== null && prefs.mutedProjects.includes(projectId)) return 'muted';
  return 'default';
}
