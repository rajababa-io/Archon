/**
 * Per-project display-name overrides.
 *
 * localStorage is the synchronous copy every label reads on its first frame;
 * the server's presentation blob is the shared one, so a rename made on the
 * desktop names the project the same way on the phone (#305).
 * `presentation-sync.ts` moves values between the two.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

const key = (projectId: string): string => `console:displayName:${projectId}`;

const listeners = new Set<() => void>();

/** Bumped on every write, so `useDisplayNames` has a snapshot to compare. */
let version = 0;

// localStorage can throw SecurityError in private-browsing modes or
// when storage is disabled by policy. Treat any failure as "no override
// stored" rather than crashing the rail row on mount.
export function getDisplayName(projectId: string, fallback: string): string {
  try {
    return localStorage.getItem(key(projectId)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The override itself, or null when the project goes by its repo name. */
export function storedDisplayName(projectId: string): string | null {
  try {
    return localStorage.getItem(key(projectId));
  } catch {
    return null;
  }
}

export function setDisplayName(projectId: string, value: string): void {
  const trimmed = value.trim();
  try {
    if (trimmed === '') localStorage.removeItem(key(projectId));
    else localStorage.setItem(key(projectId), trimmed);
  } catch {
    // Override won't persist; UI still updates for the current session
    // because the listeners below still fire.
  }
  version++;
  for (const l of listeners) l();
}

export function useDisplayName(projectId: string, fallback: string): string {
  const [value, setValue] = useState(() => getDisplayName(projectId, fallback));
  useEffect(() => {
    const sync = (): void => {
      setValue(getDisplayName(projectId, fallback));
    };
    listeners.add(sync);
    sync();
    return (): void => {
      listeners.delete(sync);
    };
  }, [projectId, fallback]);
  return value;
}

/**
 * Re-renders the caller whenever any project is renamed.
 *
 * For callers that read names through `getDisplayName` inside a callback — a
 * label function handed to a list — rather than one project at a time.
 */
export function useDisplayNames(): number {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    () => version
  );
}

/**
 * What to call a project on screen: the repo alone.
 *
 * The owner is already the rail's group header, and the header's second line
 * is the full path — a third copy of `owner/` crowds out the only part that
 * distinguishes one project from another. A rename is shown verbatim: the user
 * chose those words, so they are not ours to trim.
 */
export function projectLabel(name: string, displayName: string): string {
  if (displayName !== name) return displayName;
  const slash = name.indexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
}

/** `projectLabel` against the live override, for callers that only want the label. */
export function useProjectLabel(projectId: string, name: string): string {
  return projectLabel(name, useDisplayName(projectId, name));
}
