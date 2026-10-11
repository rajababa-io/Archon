import { describe, test, expect, afterEach } from 'bun:test';
import {
  githubGraphQl,
  isIssueReadFailure,
  repoSlug,
  toIssue,
  toIssueDetail,
} from './github-issues';

/** A node shaped the way GitHub's GraphQL actually answers. */
const RAW_ISSUE = {
  number: 42,
  title: 'The board cannot say why it is empty',
  state: 'OPEN',
  stateReason: null,
  url: 'https://github.com/o/r/issues/42',
  updatedAt: '2026-09-20T10:00:00Z',
  issueType: { name: 'Bug' },
  labels: { nodes: [{ name: 'area: web', color: 'b60205' }] },
  assignees: { nodes: [{ login: 'ameet' }] },
  closedByPullRequestsReferences: { nodes: [{ state: 'CLOSED' }, { state: 'OPEN' }] },
};

describe('toIssue', () => {
  test('flattens the connections the board reads', () => {
    expect(toIssue(RAW_ISSUE)).toEqual({
      number: 42,
      title: 'The board cannot say why it is empty',
      state: 'OPEN',
      stateReason: null,
      url: 'https://github.com/o/r/issues/42',
      updatedAt: '2026-09-20T10:00:00Z',
      type: 'Bug',
      labels: [{ name: 'area: web', color: 'b60205' }],
      assignees: ['ameet'],
      openPr: true,
    });
  });

  test('openPr is false when every closing PR is closed', () => {
    const raw = { ...RAW_ISSUE, closedByPullRequestsReferences: { nodes: [{ state: 'MERGED' }] } };
    expect(toIssue(raw).openPr).toBe(false);
  });

  test('an issue with no type, labels or assignees maps to empty, not undefined', () => {
    const issue = toIssue({ number: 1, title: 't', state: 'OPEN', url: 'u', updatedAt: 'w' });
    expect(issue.type).toBeNull();
    expect(issue.labels).toEqual([]);
    expect(issue.assignees).toEqual([]);
    expect(issue.openPr).toBe(false);
  });

  test('a null inside a connection is dropped rather than mapped', () => {
    // GitHub returns a null node for a label the token cannot see.
    const raw = { ...RAW_ISSUE, labels: { nodes: [null, { name: 'ok', color: 'fff' }] } };
    expect(toIssue(raw).labels).toEqual([{ name: 'ok', color: 'fff' }]);
  });
});

describe('toIssueDetail', () => {
  const raw = {
    ...RAW_ISSUE,
    createdAt: '2026-09-01T09:00:00Z',
    body: 'The reason is missing.',
    author: { login: 'ameet' },
    comments: {
      totalCount: 2,
      nodes: [
        { id: 'c1', createdAt: '2026-09-02T09:00:00Z', body: 'Agreed.', author: { login: 'rob' } },
        { id: 'c2', createdAt: '2026-09-03T09:00:00Z', body: 'Fixed.', author: null },
      ],
    },
  };

  test('carries the body, the author and the thread', () => {
    const detail = toIssueDetail(raw);
    expect(detail.number).toBe(42);
    expect(detail.body).toBe('The reason is missing.');
    expect(detail.author).toBe('ameet');
    expect(detail.createdAt).toBe('2026-09-01T09:00:00Z');
    expect(detail.comments).toHaveLength(2);
    expect(detail.comments[1]).toEqual({
      id: 'c2',
      // A deleted account has no login. The client shows "ghost", not "undefined".
      author: null,
      createdAt: '2026-09-03T09:00:00Z',
      body: 'Fixed.',
    });
  });

  test('an empty description is a real issue, not missing data', () => {
    expect(toIssueDetail({ ...raw, body: null }).body).toBe('');
  });

  test('moreComments counts what the page left behind', () => {
    expect(toIssueDetail(raw).moreComments).toBe(0);
    expect(
      toIssueDetail({ ...raw, comments: { ...raw.comments, totalCount: 130 } }).moreComments
    ).toBe(128);
  });

  test('moreComments never goes negative when totalCount disagrees', () => {
    expect(
      toIssueDetail({ ...raw, comments: { ...raw.comments, totalCount: 0 } }).moreComments
    ).toBe(0);
  });
});

describe('githubGraphQl', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const src = { owner: 'o', repo: 'r', token: 't' };
  const stub = (status: number, body: unknown): void => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
  };

  test('an HTTP status becomes a reason the client can explain', async () => {
    stub(404, {});
    expect(await githubGraphQl(src, 'q', {})).toEqual({ reason: 'github-404' });
  });

  test('a GraphQL error is surfaced with its message, not swallowed', async () => {
    stub(200, { errors: [{ message: 'Could not resolve to a Repository' }] });
    expect(await githubGraphQl(src, 'q', {})).toEqual({
      reason: 'Could not resolve to a Repository',
    });
  });

  test('a 200 with neither data nor a usable error is still a failure', async () => {
    stub(200, {});
    expect(await githubGraphQl(src, 'q', {})).toEqual({ reason: 'github-error' });
  });

  test('errors the caller tolerates return the partial data', async () => {
    stub(200, { data: { a: null, b: 1 }, errors: [{ type: 'FORBIDDEN', path: ['a'] }] });
    const out = await githubGraphQl(src, 'q', {}, e => e.type === 'FORBIDDEN');
    expect(out).toEqual({ data: { a: null, b: 1 } });
  });

  test('one untolerated error among tolerated ones still fails the read', async () => {
    stub(200, {
      data: { a: null, b: null },
      errors: [
        { type: 'FORBIDDEN', path: ['a'] },
        { type: 'NOT_FOUND', path: ['b'], message: 'gone' },
      ],
    });
    const out = await githubGraphQl(src, 'q', {}, e => e.type === 'FORBIDDEN');
    expect(out).toEqual({ reason: 'gone' });
  });

  test('data passes through', async () => {
    stub(200, { data: { repository: { issue: RAW_ISSUE } } });
    const out = await githubGraphQl(src, 'q', {});
    expect(out).toEqual({ data: { repository: { issue: RAW_ISSUE } } });
  });
});

describe('source helpers', () => {
  test('a failure is distinguished from a usable source', () => {
    expect(isIssueReadFailure({ repo: null, reason: 'no-repository' })).toBe(true);
    expect(isIssueReadFailure({ owner: 'o', repo: 'r', token: 't' })).toBe(false);
  });

  test('repoSlug is what every reason string reports as the repo', () => {
    expect(repoSlug({ owner: 'rajababa-io', repo: 'Archon', token: 't' })).toBe(
      'rajababa-io/Archon'
    );
  });
});
