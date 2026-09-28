/**
 * Whether this install ran without web auth the last time this phone asked.
 *
 * The shell can only open offline if it need not ask the server first, and
 * the saved chats may only be kept where nothing guards them: with web auth
 * off, anyone who reaches the server reads them anyway. With auth on, a copy
 * on the phone would outlive signing out, so none is kept.
 */
const KEY = 'archon.mobile.authOff';

export function rememberAuth(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, '1');
  } catch {
    // Storage throws with cookies disabled; the shell then waits for the server.
  }
}

export function authKnownOff(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
