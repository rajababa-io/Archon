/**
 * Why an issue board is empty, in the words a person would use.
 *
 * `GET /api/projects/:id/issues` is a thin passthrough of GitHub's own failure
 * modes, so its `reason` is an open set: four fixed strings the server decides
 * itself, `github-<status>` for any non-OK HTTP response, and GitHub's own
 * GraphQL error message otherwise. Only the fixed four were ever translated,
 * so a rejected token reached the empty state as the literal text
 * `github-401` — which says something broke but not what, and not that the
 * operator is the one who can fix it.
 *
 * Pure and side-effect free so the wording is unit-testable without rendering.
 */

/** Reasons the server decides for itself, before it ever calls GitHub. */
const FIXED: Readonly<Record<string, string>> = {
  'no-repository': 'This project has no repository, so there is nothing to read.',
  // Decided by the console, not the server: a chat with no project never asks.
  'no-project': 'This chat belongs to no project, so there is no repository to read.',
  'not-github': 'This project’s remote is not GitHub.',
  'no-token': 'No GitHub token is configured on the server.',
  'app-not-installed':
    'Archon’s GitHub App is not installed on this repository. Install it there, or give the server a token.',
  unreachable: 'GitHub could not be reached.',
  'no-such-issue': 'GitHub has no issue with that number in this repository.',
  'bad-issue-number': 'That is not an issue number.',
};

/**
 * The three statuses worth naming. Each one has a different person who can act
 * on it, which is the whole reason for spelling them out rather than printing
 * the number: 401 is the operator's token, 403 is access or rate limit, 404 is
 * a repository the token cannot see.
 */
const BY_STATUS: Readonly<Record<string, string>> = {
  '401':
    'GitHub rejected the server’s token. It is expired, revoked, or wrong — replace GITHUB_TOKEN on the server and restart Archon.',
  '403':
    'GitHub refused the request. The server’s token may not have access to this repository, or the API rate limit is used up.',
  '404':
    'GitHub cannot see this repository with the server’s token. A private repository needs a token that has access to it.',
};

export function issueReasonText(reason: string): string {
  const fixed = FIXED[reason];
  if (fixed !== undefined) return fixed;

  const status = /^github-(\d{3})$/.exec(reason);
  // Not a status code: the server passes GitHub's own GraphQL error message
  // through, which is already prose. Printing it beats inventing a summary of
  // an error this code has never seen.
  if (status === null) return reason;

  const code = status[1];
  const known = BY_STATUS[code];
  if (known !== undefined) return known;
  if (code.startsWith('5')) {
    return `GitHub is having trouble (HTTP ${code}). This is GitHub’s side, not this project’s — try again shortly.`;
  }
  return `GitHub refused the request (HTTP ${code}).`;
}
