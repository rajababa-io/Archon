/** Centralized cache key constructors. Refactoring key shape = one file. */

/** A scope is either the literal 'all' or a project id. Encoded as a string. */
export type Scope = string;
export const ALL_SCOPE = 'all';

export const scopeKey = (scope: Scope): string =>
  scope === ALL_SCOPE ? 'all' : `project:${scope}`;

export const K = {
  projects: 'projects' as const,
  project: (id: string): string => `project:${id}`,
  workflows: (cwd: string): string => `workflows:${cwd}`,
  // Encode both parts: workflow names may contain `:`, so a raw join could let
  // distinct (cwd, name) pairs collapse to the same cache key.
  workflow: (cwd: string, name: string): string =>
    `workflow:${encodeURIComponent(cwd)}:${encodeURIComponent(name)}`,
  worktrees: (projectId: string): string => `worktrees:${projectId}`,
  slashCommands: (projectId: string): string => `slashCommands:${projectId}`,
  runs: (scope: Scope): string => `runs:${scopeKey(scope)}`,
  // Under the `runs:` prefix on purpose — the dashboard SSE invalidates the
  // whole prefix, so a chat's list stays live with the project feed.
  chatRuns: (conversationDbId: string): string => `runs:conversation:${conversationDbId}`,
  run: (id: string): string => `run:${id}`,
  messages: (conversationId: string): string => `messages:${conversationId}`,
  /**
   * Whether a conversation is executing a turn right now.
   *
   * A cache key rather than component state because that is what makes it
   * recoverable: the live `conversation_lock` event writes it while the stream
   * is up, and the stream's reconnect refetches it, the same as any other key
   * the stream keeps live. State held only in a component has nothing for a
   * reconnect to ask about, which is how the composer stayed disabled after a
   * gap until the page was reloaded.
   */
  conversationLock: (conversationId: string): string => `lock:${conversationId}`,
  /** Messages waiting behind the running turn. Server-held; see `getConversationQueue`. */
  conversationQueue: (conversationId: string): string => `queue:${conversationId}`,
  conversations: (projectId: string): string => `conversations:${projectId}`,
  /**
   * Every project's chats, for the palette. Under the `conversations:` family
   * so the stream's un-narrowed invalidation reaches it; a project-narrowed one
   * does not, which is why the palette only subscribes while it is open: each
   * opening then rereads it, showing the last list until the new one lands.
   */
  allConversations: 'conversations:*all' as const,
  countsGlobal: 'counts:global' as const,
  pendingRuns: 'pendingRuns' as const,
  envVars: (projectId: string): string => `envVars:${projectId}`,
  artifacts: (runId: string): string => `artifacts:${runId}`,
  // One key per directory, which is what makes the tree lazy: expanding a
  // folder is a cache miss on that folder alone, and collapsing it keeps what
  // was already read. Both parts are encoded — a path may contain `:`.
  files: (projectId: string, path: string): string =>
    `files:${encodeURIComponent(projectId)}:${encodeURIComponent(path)}`,
  fileContent: (projectId: string, path: string): string =>
    `file:${encodeURIComponent(projectId)}:${encodeURIComponent(path)}`,
  // Installation-wide settings surfaces (static keys — one row each).
  config: 'config' as const,
  // Health has two consumers — the Settings SystemPanel and the IDE docker-check.
  // Both must read via lib/health's useHealth() so they share this one cache entry
  // instead of issuing duplicate /api/health fetches.
  health: 'health' as const,
  providers: 'providers' as const,
  updateCheck: 'update-check' as const,
  githubConnection: 'github-connection' as const,
  authStatus: 'auth-status' as const,
  activeChats: 'active-chats' as const,
  /** Rail row numbers. Its own key — see the note in skills/projectCounts.ts. */
  projectCounts: (projectId: string): string => `projectCounts:${projectId}`,
  issues: (projectId: string): string => `issues:${projectId}`,
  issue: (projectId: string, number: number): string => `issue:${projectId}:${String(number)}`,
  presentation: (projectId: string): string => `presentation:${projectId}`,
  providerConnections: 'provider-connections' as const,
  userAiPrefs: 'user-ai-prefs' as const,
  piModels: 'pi-models' as const,
} as const;
