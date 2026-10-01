/**
 * Share rows against a real SQLite schema — the per-path upsert and the code
 * that must survive it are what a mock could not show.
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

const shares = await import('./shares');

describe('shares', () => {
  test('a path keeps one code through every access change', async () => {
    const first = await shares.setShareAccess('archon/deck', 'link');
    expect(first.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.access).toBe('link');

    const off = await shares.setShareAccess('archon/deck', 'restricted');
    const on = await shares.setShareAccess('archon/deck', 'link');
    expect(off.code).toBe(first.code);
    expect(on.code).toBe(first.code);
    expect(off.access).toBe('restricted');

    expect(await shares.getShare(first.code)).toMatchObject({
      path: 'archon/deck',
      access: 'link',
    });
    expect(await shares.getShareByPath('archon/deck')).toMatchObject({ code: first.code });
  });

  test('different paths get different codes, and unknown ones read as null', async () => {
    const a = await shares.setShareAccess('a', 'link');
    const b = await shares.setShareAccess('b', 'link');
    expect(a.code).not.toBe(b.code);
    expect(await shares.getShare('nope')).toBeNull();
    expect(await shares.getShareByPath('nope')).toBeNull();
  });
});
