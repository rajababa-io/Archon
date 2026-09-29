/**
 * The console tab each signed-in person last picked (#251).
 *
 * `person` is whatever identity the caller proved — today the email on a
 * verified Cloudflare Access pass. This module stores and reads; deciding who
 * the caller is belongs to the route.
 */
import { pool, getDialect } from './connection';

/** The scope id All projects is stored under. Every project scope is a codebase id. */
export const ALL_PROJECTS_SCOPE = '';

interface ViewPrefRow {
  scope_id: string;
  view: string;
}

/** Every stored choice for one person, by scope id. */
export async function readConsoleViews(person: string): Promise<Record<string, string>> {
  const res = await pool.query<ViewPrefRow>(
    'SELECT scope_id, view FROM remote_agent_console_view_prefs WHERE person = $1',
    [person]
  );
  const views: Record<string, string> = {};
  for (const row of res.rows) views[row.scope_id] = row.view;
  return views;
}

/** Record one choice. The last write wins; there is no history. */
export async function setConsoleView(person: string, scopeId: string, view: string): Promise<void> {
  const now = getDialect().now();
  await pool.query(
    `INSERT INTO remote_agent_console_view_prefs (person, scope_id, view, updated_at)
     VALUES ($1, $2, $3, ${now})
     ON CONFLICT (person, scope_id) DO UPDATE SET view = excluded.view, updated_at = ${now}`,
    [person, scopeId, view]
  );
}
