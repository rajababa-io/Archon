/**
 * GitHub issues, as the console's board and issue dialog need them.
 *
 * The queries and the mapping from GitHub's GraphQL shape live here rather
 * than inline in the route so that both readers — the board (many issues,
 * no bodies) and the dialog (one issue, body and comments) — agree on what a
 * label, an assignee and a closing PR are. Two copies of that mapping kept
 * in agreement by hand is the bug this file exists to prevent.
 *
 * Read-only. Nothing here writes to GitHub.
 */

import * as codebaseDb from '@archon/core/db/codebases';
import { isGitHubAppModeActive, resolveBotGitHubToken } from '@archon/core';

/** A label as the board paints it. GitHub's `color` is a bare hex, no `#`. */
export interface IssueLabel {
  name: string;
  color: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  /**
   * GitHub's own value, passed through. Not narrowed to a union: the server is
   * a thin passthrough, and a value GitHub adds should reach the client rather
   * than be silently mistyped as one of two.
   */
  state: string;
  stateReason: string | null;
  url: string;
  updatedAt: string;
  /** The GitHub issue TYPE (Task / Bug / Feature), not a label. */
  type: string | null;
  labels: IssueLabel[];
  assignees: string[];
  /** An open PR that closes this issue — the difference between todo and review. */
  openPr: boolean;
}

export interface IssueComment {
  /** GitHub's node id. Only ever a React key; nothing resolves it. */
  id: string;
  /** Null for a deleted account — GitHub returns no author, not an empty one. */
  author: string | null;
  createdAt: string;
  body: string;
}

export interface GithubIssueDetail extends GithubIssue {
  /** Raw markdown. Rendered by the client, never as HTML from GitHub. */
  body: string;
  author: string | null;
  createdAt: string;
  comments: IssueComment[];
  /**
   * Comments beyond the page fetched. Shown as "N more on GitHub" rather than
   * paginated: this is a reading surface, and the escape hatch is one click.
   */
  moreComments: number;
}

/** The fields every issue view needs, shared so the two queries cannot drift. */
const ISSUE_FIELDS = `
  number title state stateReason url updatedAt
  issueType{ name }
  labels(first:20){ nodes{ name color } }
  assignees(first:5){ nodes{ login } }
  closedByPullRequestsReferences(first:5, includeClosedPrs:true){ nodes{ number state } }`;

/**
 * One query for everything the board needs. `closedByPullRequestsReferences`
 * is what distinguishes "open" from "in review" without asking GitHub twice.
 */
export const ISSUE_LIST_QUERY = `
  query($owner:String!,$repo:String!){
    repository(owner:$owner,name:$repo){
      issues(first:100, states:[OPEN,CLOSED], orderBy:{field:UPDATED_AT,direction:DESC}){
        nodes{${ISSUE_FIELDS}}
      }
    }
  }`;

/** The single issue behind the dialog: the same fields, plus the conversation. */
export const ISSUE_DETAIL_QUERY = `
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){
      issue(number:$number){${ISSUE_FIELDS}
        createdAt
        body
        author{ login }
        comments(first:100){
          totalCount
          nodes{ id createdAt body author{ login } }
        }
      }
    }
  }`;

/** GitHub's GraphQL shape. Optional throughout: a null field is GitHub's to send. */
interface RawIssue {
  number?: number;
  title?: string;
  state?: string;
  stateReason?: string | null;
  url?: string;
  updatedAt?: string;
  createdAt?: string;
  body?: string | null;
  author?: { login?: string } | null;
  issueType?: { name?: string } | null;
  labels?: { nodes?: ({ name?: string; color?: string } | null)[] | null } | null;
  assignees?: { nodes?: ({ login?: string } | null)[] | null } | null;
  closedByPullRequestsReferences?: { nodes?: ({ state?: string } | null)[] | null } | null;
  comments?: {
    totalCount?: number;
    nodes?:
      | ({
          id?: string;
          createdAt?: string;
          body?: string | null;
          author?: { login?: string } | null;
        } | null)[]
      | null;
  } | null;
}

function nodesOf<T>(conn: { nodes?: (T | null)[] | null } | null | undefined): T[] {
  return (conn?.nodes ?? []).filter((n): n is T => n !== null && n !== undefined);
}

export function toIssue(raw: unknown): GithubIssue {
  const n = raw as RawIssue;
  return {
    number: n.number ?? 0,
    title: n.title ?? '',
    state: n.state ?? '',
    stateReason: n.stateReason ?? null,
    url: n.url ?? '',
    updatedAt: n.updatedAt ?? '',
    type: n.issueType?.name ?? null,
    labels: nodesOf(n.labels).map(l => ({ name: l.name ?? '', color: l.color ?? '' })),
    assignees: nodesOf(n.assignees).map(a => a.login ?? ''),
    openPr: nodesOf(n.closedByPullRequestsReferences).some(pr => pr.state === 'OPEN'),
  };
}

export function toIssueDetail(raw: unknown): GithubIssueDetail {
  const n = raw as RawIssue;
  const comments = nodesOf(n.comments);
  return {
    ...toIssue(raw),
    // An issue opened with an empty description is ordinary, not missing data.
    body: n.body ?? '',
    author: n.author?.login ?? null,
    createdAt: n.createdAt ?? '',
    comments: comments.map(c => ({
      id: c.id ?? '',
      author: c.author?.login ?? null,
      createdAt: c.createdAt ?? '',
      body: c.body ?? '',
    })),
    moreComments: Math.max(0, (n.comments?.totalCount ?? comments.length) - comments.length),
  };
}

/**
 * Where a read stopped, when it stopped before producing issues. `reason` is
 * how a legitimately empty result explains itself: a folder-kind project with
 * no repository, a non-GitHub remote, a missing token and an unreachable
 * GitHub are all "nothing to show", and only some of them are problems. An
 * empty board that cannot say why reads as "you have no issues", which is a
 * different and usually false statement.
 */
export interface IssueReadFailure {
  repo: string | null;
  reason: string;
}

interface IssueSource {
  owner: string;
  repo: string;
  token: string;
}

/** The `owner/repo` a github.com repository URL names, or null for any other URL. */
export function githubRepoOf(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
  if (m === null) return null;
  const [, owner, repo] = m;
  return owner === undefined || repo === undefined ? null : { owner, repo };
}

/** Null means no such project — the one case that is a 404 rather than a reason. */
export async function resolveIssueSource(
  projectId: string
): Promise<IssueSource | IssueReadFailure | null> {
  const project = await codebaseDb.getCodebase(projectId);
  if (project === null) return null;

  const url = project.repository_url;
  if (url === null || url === undefined || url === '') {
    // A folder-kind project is not an error; it simply has no issues.
    return { repo: null, reason: 'no-repository' };
  }
  const found = githubRepoOf(url);
  if (found === null) return { repo: null, reason: 'not-github' };
  const { owner, repo } = found;

  // App mode mints a fresh installation token per repository and is asked
  // first, through the same resolver the workflow engine uses — a board that
  // disagreed with a run about which token speaks for a repository would be
  // the harder bug. PAT and solo installs fall back to the env var, which is
  // exactly the behaviour before App mode existed.
  const token =
    (await resolveBotGitHubToken(owner, repo)) ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token === undefined || token === '') {
    // Two different people fix these. In App mode the App is simply not
    // installed on this repository; otherwise nobody configured a token.
    return {
      repo: `${owner}/${repo}`,
      reason: isGitHubAppModeActive() ? 'app-not-installed' : 'no-token',
    };
  }
  return { owner, repo, token };
}

export function isIssueReadFailure(src: IssueSource | IssueReadFailure): src is IssueReadFailure {
  return 'reason' in src;
}

export const repoSlug = (src: IssueSource): string => `${src.owner}/${src.repo}`;

/**
 * One GraphQL POST. A transport failure, an HTTP status and a GraphQL error
 * all arrive here as a `reason` string, because to every caller they are the
 * same outcome: the read did not happen, and the reader has to say why.
 */
export async function githubGraphQl(
  src: IssueSource,
  query: string,
  variables: Record<string, unknown>
): Promise<{ data: unknown } | { reason: string }> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${src.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'archon-console',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) return { reason: `github-${String(res.status)}` };
  const body = (await res.json()) as {
    data?: unknown;
    errors?: ({ message?: string } | null)[];
  };
  const firstError = (body.errors ?? []).find(e => e !== null && e !== undefined);
  if (firstError !== undefined) return { reason: firstError.message ?? 'github-error' };
  if (body.data === null || body.data === undefined) return { reason: 'github-error' };
  return { data: body.data };
}
