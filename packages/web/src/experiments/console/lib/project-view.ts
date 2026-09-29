/**
 * Which tab a scope — All projects, or one project — was last opened in, so
 * returning to it lands where the person left it (#251).
 *
 * Two copies, with different jobs:
 *
 *   - localStorage is what the landing redirect reads, synchronously, on the
 *     first frame. It is also the whole story when nobody is signed in.
 *   - The server holds the choice per signed-in person (the verified
 *     Cloudflare Access email), which is what makes it follow them to another
 *     device. {@link loadServerViews} pulls it into localStorage once per page
 *     load; every pick is pushed up as it is made.
 *
 * The server wins on load, except for a scope picked in this page load — that
 * pick is newer than anything the server could answer with.
 */
import * as skill from '../skills';

export type ProjectView = skill.ConsoleView;

/** The scope All projects is stored under, on the server and here. Every other scope is a project id. */
export const ALL_PROJECTS_SCOPE = '';

const KEY_PREFIX = 'archon.console.projectView.';

/** Per-scope key — one project's choice never leaks into another's. */
export function projectViewKey(scopeId: string): string {
  return `${KEY_PREFIX}${scopeId}`;
}

/**
 * Normalise a stored value. Anything unrecognised — a stale key from an older
 * build, a hand-edited value — reads as "no preference" rather than throwing or
 * routing somewhere that does not exist.
 */
export function parseProjectView(raw: string | null): ProjectView | null {
  return raw === 'overview' ||
    raw === 'runs' ||
    raw === 'chat' ||
    raw === 'issues' ||
    raw === 'files'
    ? raw
    : null;
}

export function readProjectView(scopeId: string): ProjectView | null {
  try {
    return parseProjectView(localStorage.getItem(projectViewKey(scopeId)));
  } catch {
    // Storage access throws with cookies disabled and in some private-browsing
    // modes. "No preference" is a perfectly good answer there.
    return null;
  }
}

function storeLocally(scopeId: string, view: ProjectView): void {
  try {
    localStorage.setItem(projectViewKey(scopeId), view);
  } catch {
    // Best-effort: failing to remember the tab must never break navigating.
  }
}

/** Scopes picked in this page load; the server's older answer must not undo them. */
const pickedThisLoad = new Set<string>();

export function writeProjectView(scopeId: string, view: ProjectView): void {
  pickedThisLoad.add(scopeId);
  storeLocally(scopeId, view);
  // Fire-and-forget: a pick is never slowed by the server. A 401 means nobody
  // is signed in, and the local copy is then the only one there is.
  void skill.saveConsoleView(scopeId, view).catch(() => undefined);
}

let serverLoad: Promise<void> | undefined;

/**
 * Pull the signed-in person's choices into localStorage. One request per page
 * load, shared by every caller; resolves (never rejects) when it is done, so a
 * landing redirect can look again with the person's own answer.
 */
export function loadServerViews(): Promise<void> {
  serverLoad ??= skill
    .getConsoleViews()
    .then(({ views }) => {
      for (const [scopeId, view] of Object.entries(views)) {
        if (!pickedThisLoad.has(scopeId)) storeLocally(scopeId, view);
      }
    })
    .catch(() => undefined);
  return serverLoad;
}

/** Test seam: forget the page-load state. */
export function resetProjectViewState(): void {
  pickedThisLoad.clear();
  serverLoad = undefined;
}
