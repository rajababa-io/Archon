import { Check, Columns3, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { EmptyState } from '../components/EmptyState';
import {
  COLUMN_EMPTY,
  ISSUE_COLUMNS,
  issueAreas,
  issuePlacement,
  issueType,
  runningIssues,
  type IssueColumn,
  type IssuePlacement,
} from '../primitives/issue-board';
import type { Run } from '../primitives/run';
import * as skill from '../skills';
import type { GithubIssue, IssuesResponse } from '../skills';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';
import { useParams } from 'react-router';
import { IssueTypeChip } from '../components/IssueTypeChip';
import { IssueDialog } from '../components/IssueDialog';
import { useNow } from '../lib/clock';
import { relativeTime } from '../lib/format';
import { issueReasonText } from '../lib/issue-reason';
import { readHiddenColumns, writeHiddenColumns } from '../lib/issue-columns';
import { RowMenu } from '../components/RowMenu';

function Card({
  issue,
  placement,
  onOpen,
}: {
  issue: GithubIssue;
  placement: IssuePlacement;
  onOpen: () => void;
}): ReactElement {
  const type = issueType(issue);
  const areas = issueAreas(issue);
  return (
    // The card opens the issue HERE. GitHub still owns it, so the link out
    // stays — as its own control rather than as the whole card, because
    // leaving the application to read one issue was the thing worth fixing.
    // It cannot be nested inside the button: an <a> inside a <button> is
    // invalid, and browsers disagree about which one a click reaches.
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        title={`${placement.reason}\nOpens here`}
        className="block w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-left transition-colors hover:border-border-bright hover:bg-surface-hover"
      >
        <div className="text-body leading-[1.4] text-text-primary">{issue.title}</div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-mini text-text-tertiary">#{issue.number}</span>
          {type !== null ? (
            <IssueTypeChip
              name={type.name}
              derived={type.derived}
              title={
                type.derived ? 'Derived from a label — no GitHub type set' : 'GitHub issue type'
              }
            />
          ) : null}
          {areas.map(a => (
            <span
              key={a.name}
              className="inline-flex h-[17px] items-center rounded-full border px-[7px] text-mini"
              style={{ borderColor: a.color, color: 'var(--text-secondary)' }}
            >
              {a.name}
            </span>
          ))}
          {/* Reserves the row's end so the link below never lands on a chip. */}
          <span aria-hidden className="ml-auto h-3 w-3 shrink-0" />
        </div>
      </button>
      <a
        href={issue.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open issue #${String(issue.number)} on github.com`}
        title="Open on github.com"
        className="absolute bottom-[11px] right-3 text-text-tertiary opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 hover:text-text-primary"
      >
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

/**
 * A read-only board over the project's GitHub issues.
 *
 * GitHub alone gives you two columns — open and closed. An issue has no status
 * field, so the ones in between come from a `status:` label where someone set
 * one, and otherwise from what Archon already knows: an open PR that closes an
 * issue, and a run that is executing against one. Hovering a card says which
 * source placed it.
 *
 * Nothing here writes to GitHub. Status is changed by labelling the issue.
 */
export function IssuesPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  // One choice for every project's board, remembered across reloads.
  const [hidden, setHidden] = useState<ReadonlySet<IssueColumn>>(readHiddenColumns);
  useEffect(() => {
    writeHiddenColumns(hidden);
  }, [hidden]);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [columnsEl, setColumnsEl] = useState<HTMLElement | null>(null);
  const now = useNow();
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  // The card's own copy of the issue, so the dialog's header renders before
  // the detail read comes back.
  const [open, setOpen] = useState<{ issue: GithubIssue; placement: IssuePlacement } | null>(null);

  const { data, loading, error, fetchedAt } = useEntity<IssuesResponse>(K.issues(projectId), () =>
    skill.listIssues(projectId)
  );
  const { data: feed } = useEntity<{ runs: Run[] }>(K.runs(projectId), () =>
    skill.listRuns({ codebaseId: projectId, limit: skill.RUN_LIMIT })
  );

  const issues = data?.issues ?? [];
  const running = useMemo(() => runningIssues(feed?.runs ?? []), [feed?.runs]);
  const types = useMemo(
    () => [
      ...new Set(issues.map(i => issueType(i)?.name).filter((t): t is string => t !== undefined)),
    ],
    [issues]
  );

  const byColumn = useMemo(() => {
    const out = new Map<IssueColumn, { issue: GithubIssue; placement: IssuePlacement }[]>(
      ISSUE_COLUMNS.map(c => [c.key, []])
    );
    for (const i of issues) {
      const t = issueType(i)?.name;
      if (typeFilter !== null && t !== typeFilter) continue;
      const placement = issuePlacement(i, running);
      out.get(placement.column)?.push({ issue: i, placement });
    }
    return out;
  }, [issues, running, typeFilter]);

  if (error !== undefined) {
    return <EmptyState title="Could not read the issues." hint={error.message} />;
  }
  if (loading && data === undefined) return <EmptyState title="Reading GitHub…" />;

  // An empty board that cannot say WHY reads as "you have no issues", which is
  // a different and usually false statement.
  if (issues.length === 0) {
    return (
      <EmptyState
        title={
          data?.reason !== null && data?.reason !== undefined ? 'No issues to show.' : 'No issues.'
        }
        hint={
          data?.reason !== null && data?.reason !== undefined
            ? issueReasonText(data.reason)
            : `${data?.repo ?? 'This repository'} has no issues.`
        }
      />
    );
  }

  const visible = ISSUE_COLUMNS.filter(c => !hidden.has(c.key));
  const hiddenCount =
    issues.length -
    [...byColumn].filter(([k]) => !hidden.has(k)).reduce((n, [, v]) => n + v.length, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-x-2.25 gap-y-1.75 px-6.25 pb-3.75 pt-2.5">
      <div className="flex items-center gap-2">
        {/* How fresh this is, stated rather than implied.
            The prototype's line reads "Live · synced 4s ago · webhook + 60s
            conditional poll". None of that is true here: there is no issues
            webhook, the route does a plain GraphQL POST with no ETag, and
            nothing polls. It is read when you open the tab and when you press
            refresh, so that is what it says. */}
        <span className="text-small text-text-tertiary">
          {data?.repo ?? ''} · read-only
          {fetchedAt === undefined
            ? ''
            : ` · read ${relativeTime(new Date(fetchedAt).toISOString(), now)}`}
        </span>
        <button
          type="button"
          title="Read from GitHub again"
          onClick={() => {
            invalidate(K.issues(projectId));
          }}
          className="rail-ibtn"
        >
          <RefreshCw className="h-[13px] w-[13px]" />
        </button>

        {types.map(t => (
          <IssueTypeChip
            key={t}
            name={t}
            dimmed={typeFilter !== null && typeFilter !== t}
            title={typeFilter === t ? `Showing only ${t}` : `Show only ${t}`}
            onClick={() => {
              setTypeFilter(v => (v === t ? null : t));
            }}
          />
        ))}

        <div className="ml-auto flex items-center gap-2">
          {hidden.size > 0 ? (
            <span className="text-small text-text-tertiary">
              {hiddenCount} issue{hiddenCount === 1 ? '' : 's'} in {hidden.size} hidden column
              {hidden.size === 1 ? '' : 's'}
            </span>
          ) : null}
          <button
            ref={setColumnsEl}
            type="button"
            onClick={() => {
              setColumnsOpen(v => !v);
            }}
            title="Choose which columns to show"
            className="inline-flex h-[22px] items-center gap-1.5 rounded-[7px] border px-2 text-small text-text-secondary transition-colors hover:text-text-primary"
            style={{ borderColor: 'var(--border)' }}
          >
            <Columns3 className="h-[12px] w-[12px]" />
            Columns
            {hidden.size > 0 ? (
              <span className="text-text-tertiary">
                {ISSUE_COLUMNS.length - hidden.size}/{ISSUE_COLUMNS.length}
              </span>
            ) : null}
          </button>
          <RowMenu
            anchor={columnsEl}
            open={columnsOpen}
            onClose={() => {
              setColumnsOpen(false);
            }}
            width={210}
            label="Columns"
          >
            {ISSUE_COLUMNS.map(c => {
              const shown = !hidden.has(c.key);
              const n = byColumn.get(c.key)?.length ?? 0;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={shown}
                  onClick={() => {
                    setHidden(prev => {
                      const next = new Set(prev);
                      // Never hide the last one: an empty board is a dead end
                      // reachable in three clicks.
                      if (shown && next.size === ISSUE_COLUMNS.length - 1) return prev;
                      if (shown) next.add(c.key);
                      else next.delete(c.key);
                      return next;
                    });
                  }}
                  className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-body text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                >
                  <Check
                    className={`h-[13px] w-[13px] shrink-0 ${shown ? '' : 'opacity-0'}`}
                    aria-hidden
                  />
                  <span className="flex-1">{c.label}</span>
                  <span className="text-mini text-text-tertiary">{n}</span>
                </button>
              );
            })}
            {hidden.size > 0 ? (
              <>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setHidden(new Set());
                  }}
                  className="flex w-full items-center rounded-[6px] px-2 py-1.5 text-left text-body text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                >
                  Show all columns
                </button>
              </>
            ) : null}
          </RowMenu>
        </div>
      </div>

      <div
        className="grid min-h-0 flex-1 gap-x-2 gap-y-1.5"
        style={{ gridTemplateColumns: `repeat(${String(visible.length)}, minmax(0, 1fr))` }}
      >
        {visible.map(col => {
          const items = byColumn.get(col.key) ?? [];
          return (
            <section key={col.key} className="group/col flex min-h-0 flex-col">
              <div className="flex items-center gap-1.5 px-1 pb-1.25">
                <span
                  aria-hidden
                  className="h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{ background: col.color }}
                />
                <span className="text-body font-medium text-text-secondary">{col.label}</span>
                <span className="text-small text-text-tertiary">{items.length}</span>
                <button
                  type="button"
                  title={`Hide ${col.label}`}
                  aria-label={`Hide ${col.label}`}
                  onClick={() => {
                    setHidden(prev => new Set(prev).add(col.key));
                  }}
                  className="rail-ibtn ml-auto opacity-0 transition-opacity group-hover/col:opacity-100"
                >
                  ✕
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
                {items.length === 0 ? (
                  <p className="px-1 py-1.5 text-small text-text-tertiary">
                    {COLUMN_EMPTY[col.key]}
                  </p>
                ) : (
                  items.map(({ issue, placement }) => (
                    <Card
                      key={issue.number}
                      issue={issue}
                      placement={placement}
                      onOpen={() => {
                        setOpen({ issue, placement });
                      }}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>

      {open !== null ? (
        <IssueDialog
          projectId={projectId}
          issue={open.issue}
          placement={open.placement}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
    </div>
  );
}
