import { Check, Columns3, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';
import { EmptyState } from '../components/EmptyState';
import {
  boardByColumn,
  COLUMN_EMPTY,
  ISSUE_COLUMNS,
  issueAreas,
  issueType,
  type BoardCard,
  type IssueColumn,
  type IssuePlacement,
  type ProjectIssues,
} from '../primitives/issue-board';
import type { Project } from '../primitives/project';
import type { Run } from '../primitives/run';
import * as skill from '../skills';
import type { GithubIssue, IssuesResponse } from '../skills';
import { invalidate, useEntity, useEntityViews } from '../store/cache';
import { K } from '../store/keys';
import { useParams } from 'react-router';
import { IssueTypeChip } from '../components/IssueTypeChip';
import { IssueDialog } from '../components/IssueDialog';
import { useNow } from '../lib/clock';
import { relativeTime } from '../lib/format';
import { issueReasonText } from '../lib/issue-reason';
import { readHiddenColumns, writeHiddenColumns } from '../lib/issue-columns';
import { RowMenu } from '../components/RowMenu';
import { getDisplayName, projectLabel } from '../lib/display-name';

function Card({
  issue,
  placement,
  projectName,
  onOpen,
}: {
  issue: GithubIssue;
  placement: IssuePlacement;
  /** Set on the All projects board, where `#12` alone does not say which repository. */
  projectName?: string;
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
          {projectName !== undefined ? (
            <span className="inline-flex h-[17px] items-center rounded-full border border-border-bright px-[7px] text-mini text-text-secondary">
              {projectName}
            </span>
          ) : null}
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

/** One project's read, as the board takes it. */
interface IssueSource {
  projectId: string;
  projectName: string;
  data: IssuesResponse | undefined;
  error: Error | undefined;
  fetchedAt: number | undefined;
}

/**
 * A read-only board over GitHub issues — one project's, or every project's.
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
  const { projectId } = useParams<{ projectId?: string }>();
  return projectId === undefined ? (
    <AllProjectsIssues />
  ) : (
    <OneProjectIssues key={projectId} projectId={projectId} />
  );
}

function OneProjectIssues({ projectId }: { projectId: string }): ReactElement {
  const { data, error, fetchedAt } = useEntity<IssuesResponse>(K.issues(projectId), () =>
    skill.listIssues(projectId)
  );
  const { data: feed } = useEntity<{ runs: Run[] }>(K.runs(projectId), () =>
    skill.listRuns({ codebaseId: projectId, limit: skill.RUN_LIMIT })
  );
  return (
    <IssueBoard
      sources={[{ projectId, projectName: '', data, error, fetchedAt }]}
      runs={feed?.runs ?? []}
      acrossProjects={false}
    />
  );
}

/**
 * Every project's issues on one board. It reads the same `issues:<id>` entries
 * each project's own board reads, so a board already opened costs nothing and
 * the two can never disagree. Folder projects have no repository to ask and
 * are not asked.
 */
function AllProjectsIssues(): ReactElement {
  const { data: projects, error } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  const repos = (projects ?? []).filter(p => p.kind === 'repo');
  const views = useEntityViews<IssuesResponse>(
    repos.map(p => ({
      key: K.issues(p.id),
      loader: (): Promise<IssuesResponse> => skill.listIssues(p.id),
    }))
  );
  const { data: feed } = useEntity<{ runs: Run[] }>(K.runs('all'), () =>
    skill.listRuns({ limit: skill.RUN_LIMIT })
  );

  if (error !== undefined) {
    return <EmptyState title="Could not read the project list." hint={error.message} />;
  }
  if (projects === undefined) return <EmptyState title="Reading projects…" />;
  if (repos.length === 0) {
    return (
      <EmptyState
        title="No issues to show."
        hint="No project here is a GitHub repository, so there are no issues to read."
      />
    );
  }
  return (
    <IssueBoard
      sources={repos.map((p, i) => ({
        projectId: p.id,
        // The rail's own label, so a card names the project the way the rail does.
        projectName: projectLabel(p.name, getDisplayName(p.id, p.name)),
        ...views[i],
      }))}
      runs={feed?.runs ?? []}
      acrossProjects
    />
  );
}

function openCount(read: readonly ProjectIssues[]): number {
  return read.reduce((n, r) => n + r.issues.filter(i => i.state === 'OPEN').length, 0);
}

/** Why a project put nothing on the board, or null when it did its part. */
function unreadReason(s: IssueSource): string | null {
  if (s.error !== undefined) return s.error.message;
  if (s.data?.reason !== null && s.data?.reason !== undefined) {
    return issueReasonText(s.data.reason);
  }
  return null;
}

function IssueBoard({
  sources,
  runs,
  acrossProjects,
}: {
  sources: readonly IssueSource[];
  runs: readonly Run[];
  /** The All projects board: cards name their project, and the project chips show. */
  acrossProjects: boolean;
}): ReactElement {
  // One choice for every board, remembered across reloads.
  const [hidden, setHidden] = useState<ReadonlySet<IssueColumn>>(readHiddenColumns);
  useEffect(() => {
    writeHiddenColumns(hidden);
  }, [hidden]);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [columnsEl, setColumnsEl] = useState<HTMLElement | null>(null);
  const now = useNow();
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  // The card's own copy of the issue, so the dialog's header renders before
  // the detail read comes back.
  const [open, setOpen] = useState<BoardCard | null>(null);

  const read: ProjectIssues[] = sources.map(s => ({
    projectId: s.projectId,
    issues: s.data?.issues ?? [],
  }));
  const shown = projectFilter === null ? read : read.filter(r => r.projectId === projectFilter);
  const issues = shown.flatMap(r => r.issues);
  const types = [
    ...new Set(issues.map(i => issueType(i)?.name).filter((t): t is string => t !== undefined)),
  ];
  const byColumn = boardByColumn(shown, runs, typeFilter);
  const names = new Map(sources.map(s => [s.projectId, s.projectName]));
  const unread = sources
    .map(s => ({ name: s.projectName, reason: unreadReason(s) }))
    .filter((u): u is { name: string; reason: string } => u.reason !== null);
  // The oldest read, because the board is only as fresh as its stalest column.
  const stamps = sources.map(s => s.fetchedAt).filter((t): t is number => t !== undefined);
  const readAt = stamps.length === 0 ? undefined : Math.min(...stamps);
  const refresh = (): void => {
    for (const s of sources) invalidate(K.issues(s.projectId));
  };

  const single = sources.length === 1 ? sources[0] : undefined;
  if (single?.error !== undefined) {
    return <EmptyState title="Could not read the issues." hint={single.error.message} />;
  }
  const settled = sources.filter(s => s.data !== undefined || s.error !== undefined).length;
  if (settled === 0) return <EmptyState title="Reading GitHub…" />;

  // An empty board that cannot say WHY reads as "you have no issues", which is
  // a different and usually false statement.
  if (read.every(r => r.issues.length === 0) && settled === sources.length) {
    return (
      <EmptyState
        title={unread.length > 0 ? 'No issues to show.' : 'No issues.'}
        hint={
          single !== undefined
            ? unread.length > 0
              ? unread[0].reason
              : `${single.data?.repo ?? 'This repository'} has no issues.`
            : unread.length > 0
              ? unread.map(u => `${u.name}: ${u.reason}`).join(' · ')
              : 'No project has any issues.'
        }
      />
    );
  }

  const visible = ISSUE_COLUMNS.filter(c => !hidden.has(c.key));
  const hiddenCount = [...byColumn]
    .filter(([k]) => hidden.has(k))
    .reduce((n, [, v]) => n + v.length, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-x-2.25 gap-y-1.75 px-6.25 pb-3.75 pt-2.5">
      {acrossProjects ? (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Project">
          {/* Counts are OPEN issues, the figure the tab and the rail carry; a
              chip reading 100 beside a tab reading 15 would be two answers. */}
          {[
            { id: null, name: 'All', count: openCount(read) },
            ...read
              .filter(r => r.issues.length > 0)
              .map(r => ({
                id: r.projectId,
                name: names.get(r.projectId) ?? '',
                count: openCount([r]),
              })),
          ].map(p => (
            <button
              key={p.id ?? ''}
              type="button"
              aria-pressed={projectFilter === p.id}
              title={p.id === null ? 'Show every project' : `Show only ${p.name}`}
              onClick={() => {
                setProjectFilter(p.id);
                // A type chosen for one project may not exist in the next.
                setTypeFilter(null);
              }}
              className={`inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2.5 text-small transition-colors ${
                projectFilter === p.id
                  ? 'border-border-bright bg-surface-elevated text-text-primary'
                  : 'border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              {p.name}
              {p.count > 0 ? (
                <span className="tabular-nums text-text-tertiary">{p.count}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        {/* How fresh this is, stated rather than implied.
            The prototype's line reads "Live · synced 4s ago · webhook + 60s
            conditional poll". None of that is true here: there is no issues
            webhook, the route does a plain GraphQL POST with no ETag, and
            nothing polls. It is read when you open the tab and when you press
            refresh, so that is what it says. */}
        <span className="text-small text-text-tertiary">
          {single !== undefined
            ? (single.data?.repo ?? '')
            : `${String(sources.length - unread.length)} of ${String(sources.length)} repositories`}{' '}
          · read-only
          {readAt === undefined
            ? ''
            : ` · read ${relativeTime(new Date(readAt).toISOString(), now)}`}
        </span>
        {/* A project that put nothing on the board is named, never silently
            missing — a gap would otherwise read as "no issues there". */}
        {single === undefined && unread.length > 0 ? (
          <span
            className="text-small text-text-tertiary underline decoration-dotted"
            title={unread.map(u => `${u.name}: ${u.reason}`).join('\n')}
          >
            {unread.length} not read
          </span>
        ) : null}
        <button
          type="button"
          title="Read from GitHub again"
          onClick={refresh}
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
                  items.map(card => (
                    <Card
                      key={`${card.projectId}#${String(card.issue.number)}`}
                      issue={card.issue}
                      placement={card.placement}
                      projectName={acrossProjects ? names.get(card.projectId) : undefined}
                      onOpen={() => {
                        setOpen(card);
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
          projectId={open.projectId}
          number={open.issue.number}
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
