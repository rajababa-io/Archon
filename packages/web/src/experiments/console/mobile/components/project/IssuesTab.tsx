import { useMemo, useState, type ReactElement } from 'react';
import { ExternalLink } from 'lucide-react';
import * as skill from '../../../skills';
import type { IssuesResponse } from '../../../skills';
import { useEntity } from '../../../store/cache';
import { K } from '../../../store/keys';
import type { Run } from '../../../primitives/run';
import {
  COLUMN_EMPTY,
  ISSUE_COLUMNS,
  issueType,
  issuesByColumn,
  runningIssues,
  type IssueColumn,
} from '../../../primitives/issue-board';
import { issueReasonText } from '../../../lib/issue-reason';

/**
 * The desktop issue board as one column at a time: a row of column chips with
 * their counts, and the chosen column's issues. Read-only — an issue opens on
 * GitHub, and status is still changed by labelling it there.
 */
export function IssuesTab({ projectId }: { projectId: string }): ReactElement {
  const [column, setColumn] = useState<IssueColumn>('todo');
  const { data, error } = useEntity<IssuesResponse>(K.issues(projectId), () =>
    skill.listIssues(projectId)
  );
  const { data: feed } = useEntity<{ runs: Run[] }>(K.runs(projectId), () =>
    skill.listRuns({ codebaseId: projectId, limit: skill.RUN_LIMIT })
  );
  const issues = data?.issues;
  const running = useMemo(() => runningIssues(feed?.runs ?? []), [feed?.runs]);
  const board = useMemo(() => issuesByColumn(issues ?? [], running), [issues, running]);

  if (error !== undefined) {
    return <p className="mobile-note text-error">Couldn&apos;t read the issues: {error.message}</p>;
  }
  if (data === undefined) return <p className="mobile-note">Reading GitHub…</p>;
  if (data.issues.length === 0) {
    return (
      <p className="mobile-note">
        {data.reason !== null
          ? issueReasonText(data.reason)
          : `${data.repo ?? 'This repository'} has no issues.`}
      </p>
    );
  }

  const shown = board.get(column) ?? [];
  return (
    <div className="flex flex-col">
      <div
        role="group"
        aria-label="Column"
        className="flex shrink-0 gap-2 overflow-x-auto px-4 py-2 [scrollbar-width:none]"
      >
        {ISSUE_COLUMNS.map(c => (
          <button
            key={c.key}
            type="button"
            aria-pressed={c.key === column}
            onClick={() => {
              setColumn(c.key);
            }}
            className="mobile-tap flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-small text-text-secondary aria-pressed:bg-surface-hover aria-pressed:text-text-primary"
          >
            <span aria-hidden className="size-2 rounded-full" style={{ background: c.color }} />
            {c.label}
            <span className="tabular-nums">{board.get(c.key)?.length ?? 0}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="mobile-note">Nothing here: {COLUMN_EMPTY[column]}.</p>
      ) : (
        <ul aria-label={ISSUE_COLUMNS.find(c => c.key === column)?.label}>
          {shown.map(({ issue, placement }) => {
            const type = issueType(issue);
            return (
              <li key={issue.number}>
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mobile-row flex items-center gap-3 px-4"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-body leading-snug text-text-primary">
                      {issue.title}
                    </span>
                    <span className="block truncate text-small text-text-tertiary">
                      #{issue.number}
                      {type !== null ? ` · ${type.name}` : ''} · {placement.reason}
                    </span>
                  </span>
                  <ExternalLink aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
