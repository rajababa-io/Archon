/**
 * The browser-notification opt-in, for this browser.
 *
 * Two halves have to agree before anything is shown: the browser's permission,
 * which only a click may ask for, and the reader's own switch, which is off
 * until they turn it on. The switch exists because permission cannot be taken
 * back from a page — without it, "stop notifying me" would mean a trip into
 * the browser's site settings.
 *
 * localStorage, like the console's other per-browser preferences: permission
 * is granted per browser, so the preference that pairs with it lives there too.
 */

const PREF_KEY = 'archon.console.notify';

export type NotifyState =
  /** This browser has no Notification API (or the page is not a secure context). */
  | 'unsupported'
  /** The browser refused, and only its own settings can undo that. */
  | 'blocked'
  | 'off'
  | 'on';

export function notifyState(): NotifyState {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return Notification.permission === 'granted' && readPref() ? 'on' : 'off';
}

/**
 * Turn notifications on. Call ONLY from a user action: browsers ignore or
 * penalise a permission prompt nobody asked for, and the issue that added this
 * forbids one on page load.
 */
export async function enableNotify(): Promise<NotifyState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  const permission =
    Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission === 'granted') writePref(true);
  return notifyState();
}

export function disableNotify(): void {
  writePref(false);
}

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    // Storage throws with cookies disabled; that reads as never opted in.
    return false;
  }
}

function writePref(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREF_KEY, 'on');
    else localStorage.removeItem(PREF_KEY);
  } catch {
    // Nothing to fall back to: the switch simply will not stick.
  }
}
