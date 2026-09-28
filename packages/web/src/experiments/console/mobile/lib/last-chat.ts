/**
 * The chat the mobile shell was last showing, so `/m` reopens it.
 *
 * One chat across every project, unlike the desktop console's per-project
 * memory: the phone has no project rail to choose a project from first.
 */
const KEY = 'archon.mobile.lastChat';

export function readMobileLastChat(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw !== null && raw !== '' ? raw : null;
  } catch {
    // Storage throws with cookies disabled and in some private-browsing modes.
    return null;
  }
}

export function writeMobileLastChat(conversationId: string): void {
  try {
    localStorage.setItem(KEY, conversationId);
  } catch {
    // Best-effort: failing to remember must never break opening the chat.
  }
}
