/**
 * Share links (#345): a published page or file reachable at `/share/<code>/`
 * without the deployment's login.
 *
 * This module stores and reads. Which paths may be shared, and how a request
 * resolves to a file, belongs to `services/shares.ts`.
 */
import { randomBytes } from 'crypto';
import { pool, getDialect } from './connection';
import { toHydratedTimestamp } from './timestamps';

/** `link`: anyone with the address. `restricted`: the address answers 404. */
export type ShareAccess = 'link' | 'restricted';

export interface Share {
  /** The unguessable part of the address. Never changes once issued. */
  code: string;
  /** Relative to the public files root — what follows `/files/` in its private address. */
  path: string;
  access: ShareAccess;
  createdAt: Date;
  updatedAt: Date;
}

interface ShareRow {
  code: string;
  path: string;
  access: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toShare(row: ShareRow): Share {
  return {
    code: row.code,
    path: row.path,
    // The CHECK constraint holds the column to these two values.
    access: row.access === 'link' ? 'link' : 'restricted',
    createdAt: toHydratedTimestamp(row.created_at),
    updatedAt: toHydratedTimestamp(row.updated_at),
  };
}

const COLUMNS = 'code, path, access, created_at, updated_at';

/**
 * 128 random bits, base64url — 22 characters. The code is the only thing
 * standing between a share and anyone who guesses addresses, so it comes from
 * the CSPRNG and is long enough that guessing is not a strategy.
 */
export function newShareCode(): string {
  return randomBytes(16).toString('base64url');
}

export async function getShare(code: string): Promise<Share | null> {
  const res = await pool.query<ShareRow>(
    `SELECT ${COLUMNS} FROM remote_agent_shares WHERE code = $1`,
    [code]
  );
  const row = res.rows[0];
  return row ? toShare(row) : null;
}

export async function getShareByPath(path: string): Promise<Share | null> {
  const res = await pool.query<ShareRow>(
    `SELECT ${COLUMNS} FROM remote_agent_shares WHERE path = $1`,
    [path]
  );
  const row = res.rows[0];
  return row ? toShare(row) : null;
}

/**
 * Set a path's access, issuing its code the first time.
 *
 * One share per path, and the code survives every later change: turning a
 * share off and on again must not break the link people were already sent.
 * The unique `path` decides a concurrent first share rather than a
 * read-then-write here.
 */
export async function setShareAccess(path: string, access: ShareAccess): Promise<Share> {
  const now = getDialect().now();
  const res = await pool.query<ShareRow>(
    `INSERT INTO remote_agent_shares (code, path, access, created_at, updated_at)
     VALUES ($1, $2, $3, ${now}, ${now})
     ON CONFLICT (path) DO UPDATE SET access = excluded.access, updated_at = ${now}
     RETURNING ${COLUMNS}`,
    [newShareCode(), path, access]
  );
  const row = res.rows[0];
  if (!row) throw new Error(`Share upsert for ${path} returned no row`);
  return toShare(row);
}
