/**
 * Every address in the phone shell, built in one place so a link and the route
 * that answers it cannot disagree. The routes themselves are in MobileApp.
 */

export const PROJECT_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'runs', label: 'Runs' },
  { key: 'chats', label: 'Chats' },
  { key: 'issues', label: 'Issues' },
  { key: 'files', label: 'Files' },
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number]['key'];

/** The tab a `/m/p/:projectId/:tab` segment names; no segment is Overview, anything else null. */
export function parseProjectTab(segment: string | undefined): ProjectTab | null {
  if (segment === undefined || segment === '') return 'overview';
  return PROJECT_TABS.find(t => t.key === segment)?.key ?? null;
}

export function chatPath(conversationId: string): string {
  return `/m/c/${encodeURIComponent(conversationId)}`;
}

/** A project's screen; Overview has no segment of its own. */
export function projectPath(projectId: string, tab: ProjectTab = 'overview'): string {
  const base = `/m/p/${encodeURIComponent(projectId)}`;
  return tab === 'overview' ? base : `${base}/${tab}`;
}

/** The Files tab, opened on one directory. The root is the tab itself. */
export function directoryPath(projectId: string, dir: string): string {
  const base = projectPath(projectId, 'files');
  return dir === '' ? base : `${base}?dir=${encodeURIComponent(dir)}`;
}

/** One file's viewer. Each path segment is encoded; the slashes between them are not. */
export function filePath(projectId: string, path: string): string {
  const segments = path.split('/').map(encodeURIComponent).join('/');
  return `/m/files/${encodeURIComponent(projectId)}/${segments}`;
}

export function runPath(runId: string): string {
  return `/m/r/${encodeURIComponent(runId)}`;
}

export const SETTINGS_PATH = '/m/settings';
