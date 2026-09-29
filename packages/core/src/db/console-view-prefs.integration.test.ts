/**
 * Console tab memory against a real SQLite schema — the upsert on
 * (person, scope) and the per-person split are what a mock could not show.
 */
import { describe, test, expect, mock } from 'bun:test';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const views = await import('./console-view-prefs');

describe('console view prefs', () => {
  test('picking again replaces the choice, and each person keeps their own', async () => {
    await views.setConsoleView('you@example.com', views.ALL_PROJECTS_SCOPE, 'runs');
    await views.setConsoleView('you@example.com', views.ALL_PROJECTS_SCOPE, 'chat');
    await views.setConsoleView('you@example.com', 'proj-1', 'issues');
    await views.setConsoleView('them@example.com', views.ALL_PROJECTS_SCOPE, 'runs');

    expect(await views.readConsoleViews('you@example.com')).toEqual({
      '': 'chat',
      'proj-1': 'issues',
    });
    expect(await views.readConsoleViews('them@example.com')).toEqual({ '': 'runs' });
    expect(await views.readConsoleViews('nobody@example.com')).toEqual({});
  });
});
