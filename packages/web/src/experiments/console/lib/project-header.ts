/** What the persistent project header says on its right-hand side. */
import type { ProjectView } from './project-view';

export interface HeaderCounts {
  running: number;
  paused: number;
}

/**
 * Live activity for the project being viewed, or null when there is none.
 *
 * Null rather than "0 running" on purpose: an idle project should show nothing
 * at all. A permanent zero is noise that teaches you to stop reading the
 * corner, which defeats the point of putting it there.
 *
 * Paused is included because a paused run is waiting on *you* — it is the one
 * state where not noticing has a cost.
 */
export function activitySummary(counts: HeaderCounts | null | undefined): string | null {
  if (counts == null) return null;
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running.toString()} running`);
  if (counts.paused > 0) parts.push(`${counts.paused.toString()} paused`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * True when the activity is waiting on the user rather than merely in progress.
 * Drives the color: work in flight is informational, work that has stopped for
 * a human is not.
 */
export function activityNeedsYou(counts: HeaderCounts | null | undefined): boolean {
  return counts != null && counts.paused > 0;
}

/**
 * What the tab row carries on its right when no project is scoped. The header
 * fills that corner in every state so that picking a project never changes its
 * height — anything below it would otherwise jump.
 */
export function allProjectsSubtitle(
  projectCount: number,
  counts: HeaderCounts | null | undefined
): string {
  const projects = `${projectCount.toString()} project${projectCount === 1 ? '' : 's'}`;
  const activity = activitySummary(counts);
  return activity === null ? projects : `${projects} · ${activity}`;
}

/**
 * The project path as the tab row shows it: the last few segments, with what
 * was dropped marked by a leading ellipsis.
 *
 * Every checkout sits under the same workspaces root, so the leading half of
 * the path is identical on every project page and identifies nothing. Trimming
 * it here rather than truncating in CSS keeps the informative end — the one
 * you would paste into a terminal — from being the half that disappears.
 *
 * The full path stays on the element's title, so nothing is unrecoverable.
 */
const HEADER_PATH_SEGMENTS = 3;

export function headerPathLabel(path: string): string {
  const segments = path.split('/').filter(segment => segment !== '');
  if (segments.length <= HEADER_PATH_SEGMENTS) return path;
  return `…/${segments.slice(-HEADER_PATH_SEGMENTS).join('/')}`;
}

/**
 * Which tab the header lights, derived from the URL rather than passed in —
 * the header renders in the layout, above and outside the page that knows.
 *
 * A run detail lights Runs, not nothing: a run belongs to Runs, and an
 * unlit tab strip on a run page reads as "you have left the project".
 */
export function activeProjectTab(pathname: string): ProjectView {
  if (/\/chat\/?$/.test(pathname)) return 'chat';
  if (/\/issues\/?$/.test(pathname)) return 'issues';
  if (/\/overview\/?$/.test(pathname)) return 'overview';
  if (/\/files\/?$/.test(pathname)) return 'files';
  // Runs is the bare project path AND a run's detail page, which has no tab of
  // its own — a run belongs to Runs, so that is what stays lit while you read
  // one.
  return 'runs';
}

/**
 * Whether the header carries the install-wide deploy strip: Archon's own
 * deploy, read from `/api/health`. Only on All projects (#319).
 *
 * On a project's page the header's top row is read as that project's, so
 * Archon's "Deploy failed" beside another project's name was taken for that
 * project's failure. The Archon project needs no strip either: its own deploy
 * row already reports this deploy. DeployOverlay still interrupts every route
 * for the phases that stop you typing, so no page loses the urgent half.
 */
export function showsInstallDeployStrip(projectId: string | undefined): boolean {
  return projectId === undefined;
}
