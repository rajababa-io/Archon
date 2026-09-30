import { describe, expect, test } from 'bun:test';
import type { GithubIssue } from '../skills';
import {
  boardByColumn,
  COLUMN_EMPTY,
  ISSUE_COLUMNS,
  issuePlacement,
  issuesByColumn,
  runningIssues,
  statusColumn,
} from './issue-board';

const issue = (over: Partial<GithubIssue> = {}): GithubIssue => ({
  number: 1,
  title: 'an issue',
  state: 'OPEN',
  stateReason: null,
  url: 'https://github.com/o/r/issues/1',
  updatedAt: '2026-09-26T00:00:00Z',
  type: null,
  labels: [],
  assignees: [],
  openPr: false,
  ...over,
});

const label = (name: string) => ({ name, color: 'ffffff' });
const none: ReadonlySet<number> = new Set();

describe('statusColumn', () => {
  test('reads each label the convention defines', () => {
    expect(statusColumn(issue({ labels: [label('status: todo')] }))).toBe('todo');
    expect(statusColumn(issue({ labels: [label('status: blocked')] }))).toBe('blocked');
    expect(statusColumn(issue({ labels: [label('status: in progress')] }))).toBe('prog');
    expect(statusColumn(issue({ labels: [label('status: in review')] }))).toBe('rev');
  });

  test('is case- and spacing-insensitive, because a human types these', () => {
    expect(statusColumn(issue({ labels: [label('Status:In Progress')] }))).toBe('prog');
    expect(statusColumn(issue({ labels: [label('STATUS :  in review')] }))).toBe('rev');
  });

  test('ignores a prefixed label naming no column, rather than guessing one', () => {
    expect(statusColumn(issue({ labels: [label('status: marinating')] }))).toBeNull();
  });

  test('ignores labels that are not statuses', () => {
    expect(statusColumn(issue({ labels: [label('bug'), label('area: credentials')] }))).toBeNull();
  });
});

describe('issuePlacement', () => {
  test('closed outranks every label — a done issue is done', () => {
    const p = issuePlacement(
      issue({ state: 'CLOSED', labels: [label('status: in progress')] }),
      none
    );
    expect(p.column).toBe('done');
  });

  test('a label outranks the open-PR derivation', () => {
    const p = issuePlacement(issue({ openPr: true, labels: [label('status: blocked')] }), none);
    expect(p.column).toBe('blocked');
    expect(p.reason).toContain('status label');
  });

  test('`status: todo` pulls an issue back out of the column a PR put it in', () => {
    expect(issuePlacement(issue({ openPr: true }), none).column).toBe('rev');
    expect(
      issuePlacement(issue({ openPr: true, labels: [label('status: todo')] }), none).column
    ).toBe('todo');
  });

  test('a label outranks a running run', () => {
    const p = issuePlacement(
      issue({ number: 7, labels: [label('status: in review')] }),
      new Set([7])
    );
    expect(p.column).toBe('rev');
  });

  test('the derivations still place an unlabelled issue', () => {
    expect(issuePlacement(issue({ openPr: true }), none).reason).toContain('open PR');
    expect(issuePlacement(issue({ number: 7 }), new Set([7])).reason).toContain('run');
    expect(issuePlacement(issue(), none).column).toBe('todo');
  });
});

describe('runningIssues', () => {
  test('collects issue numbers only from runs that are running', () => {
    expect(
      runningIssues([
        { status: 'running', userMessage: 'fix #12 and #34' },
        { status: 'completed', userMessage: 'fix #56' },
        { status: 'running', userMessage: null },
      ])
    ).toEqual(new Set([12, 34]));
  });
});

describe('the board', () => {
  test('every column has an empty-state line, so a 0 says why', () => {
    for (const c of ISSUE_COLUMNS) expect(COLUMN_EMPTY[c.key]).toBeTruthy();
  });
});

describe('issuesByColumn', () => {
  test('places every issue, keeps their order, and lists every column', () => {
    const board = issuesByColumn(
      [
        issue({ number: 1 }),
        issue({ number: 2, state: 'CLOSED' }),
        issue({ number: 3 }),
        issue({ number: 4, openPr: true }),
      ],
      new Set([3])
    );
    expect([...board.keys()]).toEqual(ISSUE_COLUMNS.map(c => c.key));
    const numbers = (column: Parameters<typeof board.get>[0]): number[] =>
      (board.get(column) ?? []).map(p => p.issue.number);
    expect(numbers('todo')).toEqual([1]);
    expect(numbers('prog')).toEqual([3]);
    expect(numbers('rev')).toEqual([4]);
    expect(numbers('done')).toEqual([2]);
    expect(numbers('blocked')).toEqual([]);
  });

  test('a type filter keeps only issues of that type', () => {
    const board = issuesByColumn(
      [issue({ number: 1, type: 'Bug' }), issue({ number: 2, type: 'Task' })],
      none,
      'Bug'
    );
    expect((board.get('todo') ?? []).map(p => p.issue.number)).toEqual([1]);
  });
});

describe('boardByColumn', () => {
  test("a run marks its own project's issue, never the same number in another project", () => {
    const board = boardByColumn(
      [
        { projectId: 'archon', issues: [issue({ number: 12 })] },
        { projectId: 'atlas', issues: [issue({ number: 12 })] },
      ],
      [{ status: 'running', userMessage: 'fix #12', projectId: 'atlas' }]
    );
    expect(board.get('prog')?.map(c => c.projectId)).toEqual(['atlas']);
    expect(board.get('todo')?.map(c => c.projectId)).toEqual(['archon']);
  });

  test('across projects, a column is newest first so the projects interleave', () => {
    const board = boardByColumn(
      [
        {
          projectId: 'a',
          issues: [
            issue({ number: 1, updatedAt: '2026-09-03T00:00:00Z' }),
            issue({ number: 2, updatedAt: '2026-09-01T00:00:00Z' }),
          ],
        },
        { projectId: 'b', issues: [issue({ number: 3, updatedAt: '2026-09-02T00:00:00Z' })] },
      ],
      []
    );
    expect(board.get('todo')?.map(c => c.issue.number)).toEqual([1, 3, 2]);
  });

  test('one project keeps the order it was given', () => {
    const board = boardByColumn(
      [
        {
          projectId: 'a',
          issues: [
            issue({ number: 1, updatedAt: '2026-09-01T00:00:00Z' }),
            issue({ number: 2, updatedAt: '2026-09-03T00:00:00Z' }),
          ],
        },
      ],
      []
    );
    expect(board.get('todo')?.map(c => c.issue.number)).toEqual([1, 2]);
  });

  test('a run with no project names nothing', () => {
    const board = boardByColumn(
      [{ projectId: 'a', issues: [issue({ number: 5 })] }],
      [{ status: 'running', userMessage: '#5', projectId: null }]
    );
    expect(board.get('prog')).toEqual([]);
  });
});
