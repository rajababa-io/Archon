/**
 * Which Issues-board columns are hidden, so the choice survives a reload and a
 * project switch instead of resetting to all five every time.
 *
 * One key for every project, not one per project: the columns are the same
 * five everywhere, and hiding one is a statement about how the operator reads
 * a board, not about any one repository. Backed by localStorage, like every
 * other console view preference — per browser profile, which is per user in
 * practice.
 */

import { ISSUE_COLUMNS, type IssueColumn } from '../primitives/issue-board';

export const HIDDEN_COLUMNS_KEY = 'archon.console.issues.hiddenColumns';

/**
 * Normalise a stored value. Unknown keys are dropped, and a value that would
 * hide every column reads as nothing hidden — an empty board is a dead end, the
 * same rule the menu enforces on click. Anything unparseable is no preference.
 */
export function parseHiddenColumns(raw: string | null): ReadonlySet<IssueColumn> {
  if (raw === null) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const known = new Set<string>(ISSUE_COLUMNS.map(c => c.key));
  const hidden = new Set(
    parsed.filter((k): k is IssueColumn => typeof k === 'string' && known.has(k))
  );
  return hidden.size >= ISSUE_COLUMNS.length ? new Set() : hidden;
}

export function readHiddenColumns(): ReadonlySet<IssueColumn> {
  try {
    return parseHiddenColumns(localStorage.getItem(HIDDEN_COLUMNS_KEY));
  } catch {
    // Storage access throws with cookies disabled and in some private-browsing
    // modes. Showing every column is a perfectly good answer there.
    return new Set();
  }
}

export function writeHiddenColumns(hidden: ReadonlySet<IssueColumn>): void {
  try {
    if (hidden.size === 0) localStorage.removeItem(HIDDEN_COLUMNS_KEY);
    else localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...hidden]));
  } catch {
    // Best-effort: failing to remember the choice must never break the board.
  }
}
