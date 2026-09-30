/**
 * Keeps the local presentation stores and the server in step.
 *
 * The icon, the rename and the rail order are read SYNCHRONOUSLY during render — the rail
 * draws a glyph on its first frame — so they stay in localStorage. This pushes
 * every change up and pulls the server's copy down, which is what makes them
 * follow you to another machine.
 *
 * The BRIEF is not here. It is written by the agent, never by the reader, so
 * there is no local copy to reconcile: it arrives on the project row and is
 * read straight off it.
 *
 * Every server call is failure-tolerant on purpose. The route does not exist
 * until the container restarts, and a console that broke its own icons while
 * waiting for a deploy would be a worse bug than the one being fixed. Before
 * the restart this behaves exactly as it did; after it, the same writes start
 * landing.
 */
import * as skill from '../skills';
import { getIdentity, setIdentity } from './project-identity';
import { setDisplayName, storedDisplayName } from './display-name';
import { readProjectOrder, writeProjectOrder } from './project-order';

const MIGRATED = 'archon.console.presentationMigrated';

/** Fire-and-forget. A failed save leaves localStorage authoritative. */
export function pushIdentity(projectId: string): void {
  const id = getIdentity(projectId);
  void skill
    .savePresentation(projectId, { presentation: { color: id.color, glyph: id.glyph } })
    .catch(() => undefined);
}

/** Fire-and-forget, like `pushIdentity`. null clears the rename everywhere. */
export function pushDisplayName(projectId: string): void {
  void skill
    .savePresentation(projectId, {
      presentation: { displayName: storedDisplayName(projectId) },
    })
    .catch(() => undefined);
}

export type DisplayNameStep =
  | { kind: 'apply'; value: string | null }
  | { kind: 'push' }
  | { kind: 'none' };

/**
 * Which way a rename travels for one project.
 *
 * The server wins as soon as it holds the key at all — null included, since
 * that is a rename someone cleared. Until then, only a browser that HAS a
 * rename pushes it. A browser with none must not push null: the phone would
 * then sync first after a deploy and wipe the desktop's names before the
 * desktop ever uploaded them. That is also why this does not ride the
 * per-project `migrated` flag — every project is already marked migrated for
 * the icon, so the flag would stop the rename ever going up.
 */
export function displayNameStep(
  server: skill.ProjectPresentation | null,
  local: string | null
): DisplayNameStep {
  if (server !== null && 'displayName' in server) {
    const value = server.displayName ?? null;
    return value === local ? { kind: 'none' } : { kind: 'apply', value };
  }
  return local !== null ? { kind: 'push' } : { kind: 'none' };
}

/** The rail order is a list, so it is written as a position per project. */
export function pushOrder(order: readonly string[]): void {
  order.forEach((projectId, index) => {
    void skill.savePresentation(projectId, { sortOrder: index }).catch(() => undefined);
  });
}

/**
 * Pull the server's copy down, and push local values up the first time.
 *
 * Direction matters and is decided per project, not globally: the server wins
 * when it has anything, because it is the shared copy. A browser that has
 * something the server does not is the pre-migration case, and that is the one
 * time local wins — otherwise a second machine opening the console would
 * overwrite the first machine's choices with its own empty defaults.
 */
export async function syncPresentation(projectIds: readonly string[]): Promise<void> {
  let migrated: Record<string, true> = {};
  try {
    const raw = localStorage.getItem(MIGRATED);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) migrated = parsed as Record<string, true>;
  } catch {
    migrated = {};
  }

  const localOrder = readProjectOrder();
  const serverOrder: { id: string; at: number }[] = [];

  for (const projectId of projectIds) {
    let remote: skill.PresentationResponse;
    try {
      remote = await skill.getPresentation(projectId);
    } catch {
      // Route missing (pre-restart) or offline. Nothing to reconcile.
      continue;
    }

    const p = remote.presentation;
    const serverHasIdentity = p != null && (p.color != null || p.glyph != null);

    if (serverHasIdentity) {
      setIdentity(projectId, { color: p.color ?? null, glyph: p.glyph ?? null });
    } else if (!migrated[projectId]) {
      pushIdentity(projectId);
    }

    const name = displayNameStep(p, storedDisplayName(projectId));
    if (name.kind === 'apply') setDisplayName(projectId, name.value ?? '');
    else if (name.kind === 'push') pushDisplayName(projectId);

    if (remote.sortOrder !== null) serverOrder.push({ id: projectId, at: remote.sortOrder });
    migrated[projectId] = true;
  }

  if (serverOrder.length > 0) {
    writeProjectOrder(serverOrder.sort((a, b) => a.at - b.at).map(o => o.id));
  } else if (localOrder.length > 0) {
    pushOrder(localOrder);
  }

  try {
    localStorage.setItem(MIGRATED, JSON.stringify(migrated));
  } catch {
    /* the sync still ran; it will simply run again next time */
  }
}
