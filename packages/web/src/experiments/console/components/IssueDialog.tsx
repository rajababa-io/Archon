import { ExternalLink, MessageSquare, X } from 'lucide-react';
import { useEffect, useRef, type ReactElement } from 'react';
import { Markdown } from './Markdown';
import { IssueTypeChip } from './IssueTypeChip';
import { useNow } from '../lib/clock';
import { relativeTime } from '../lib/format';
import { issueReasonText } from '../lib/issue-reason';
import { ISSUE_COLUMNS, issueType, type IssuePlacement } from '../primitives/issue-board';
import * as skill from '../skills';
import type { GithubIssue, GithubIssueDetail, IssueComment, IssueDetailResponse } from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';

interface IssueDialogProps {
  /** Null for a chat with no project: there is no repository to read, and the dialog says so. */
  projectId: string | null;
  number: number;
  /**
   * The board's copy. Renders immediately, so opening from the board never
   * starts blank. Absent when opened from a number alone — a chat title — and
   * the header fills in when the read lands.
   */
  issue?: GithubIssue;
  /**
   * Where the board put it, passed in so the dialog cannot disagree with it.
   * Absent off the board: the column depends on which runs are live, and a
   * guess made without them would be a second, different answer.
   */
  placement?: IssuePlacement;
  onClose: () => void;
}

/** What a chat with no project reads as — a reason, like any other empty read. */
const NO_PROJECT: IssueDetailResponse = { issue: null, repo: null, reason: 'no-project' };

/**
 * One GitHub issue, read inside the console.
 *
 * An iframe of github.com was the obvious idea and it is impossible: GitHub
 * serves `x-frame-options: deny`, and a frame is a separate document our CSS
 * cannot reach anyway — it would arrive wearing GitHub's styling, which is the
 * opposite of the point. So the server returns the markdown and this renders
 * it with the same components the chat uses.
 *
 * Read-only, deliberately. There is no comment box and no state control,
 * because there is no route behind them; the link to github.com is where
 * interacting starts.
 */
export function IssueDialog(props: IssueDialogProps): ReactElement {
  return props.projectId === null ? (
    <IssueDialogView {...props} data={NO_PROJECT} loading={false} error={undefined} />
  ) : (
    <FetchedIssueDialog {...props} projectId={props.projectId} />
  );
}

function FetchedIssueDialog(props: IssueDialogProps & { projectId: string }): ReactElement {
  const { projectId, number } = props;
  const { data, loading, error } = useEntity<IssueDetailResponse>(K.issue(projectId, number), () =>
    skill.getIssue(projectId, number)
  );
  return <IssueDialogView {...props} data={data} loading={loading} error={error} />;
}

function IssueDialogView({
  number,
  issue: boardCopy,
  placement,
  onClose,
  data,
  loading,
  error,
}: IssueDialogProps & {
  data: IssueDetailResponse | undefined;
  loading: boolean;
  error: Error | undefined;
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const now = useNow();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Move focus into the dialog, so Escape and the scroll keys reach it rather
  // than the board still sitting behind.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const detail = data?.issue ?? null;
  const issue: GithubIssue | null = boardCopy ?? detail;
  const col =
    placement === undefined ? undefined : ISSUE_COLUMNS.find(c => c.key === placement.column);
  const type = issue === null ? null : issueType(issue);
  const title = issue?.title ?? `Issue #${String(number)}`;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6 backdrop-blur-[6px]"
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Issue #${String(number)}: ${title}`}
        tabIndex={-1}
        onMouseDown={e => {
          e.stopPropagation();
        }}
        className="relative my-auto w-full max-w-[760px] overflow-hidden rounded-lg border bg-surface-elevated text-text-primary shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)] outline-none"
        // Inline because the console scope's wildcard border-color rule
        // repaints Tailwind border utilities (see theme.css).
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <span aria-hidden className="brand-bar absolute left-0 right-0 top-0 h-[2px] opacity-90" />

        <header className="flex items-start gap-2.25 px-[17px] pb-1.75 pt-[12.5px]">
          <div className="min-w-0 flex-1">
            <h2 className="text-large font-medium leading-[1.35] text-text-primary">{title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {col !== undefined && placement !== undefined ? (
                <span
                  title={placement.reason}
                  className="inline-flex h-[19px] items-center gap-1.5 rounded-full border px-[9px] text-mini text-text-secondary"
                  style={{ borderColor: col.color }}
                >
                  <span
                    aria-hidden
                    className="h-[6px] w-[6px] rounded-full"
                    style={{ background: col.color }}
                  />
                  {col.label}
                </span>
              ) : null}
              <span className="text-mini text-text-tertiary">#{number}</span>
              {type !== null ? <IssueTypeChip name={type.name} derived={type.derived} /> : null}
              {issue?.labels.map(l => (
                <span
                  key={l.name}
                  className="inline-flex h-[17px] items-center rounded-full border px-[7px] text-mini"
                  style={{ borderColor: `#${l.color}`, color: 'var(--text-secondary)' }}
                >
                  {l.name}
                </span>
              ))}
              {issue !== null && issue.assignees.length > 0 ? (
                <span className="text-mini text-text-tertiary">
                  assigned to {issue.assignees.join(', ')}
                </span>
              ) : null}
            </div>
          </div>
          {issue !== null ? (
            <a
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open on github.com — the only place you can reply or change it"
              className="rail-ibtn shrink-0"
            >
              <ExternalLink className="h-[13px] w-[13px]" />
            </a>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="rail-ibtn shrink-0"
          >
            <X className="h-[13px] w-[13px]" />
          </button>
        </header>

        <div
          className="max-h-[70vh] overflow-y-auto border-t px-[17px] py-2.5"
          style={{ borderColor: 'var(--border)' }}
        >
          {error !== undefined ? (
            <Note>{`Could not read this issue. ${error.message}`}</Note>
          ) : data?.reason !== null && data?.reason !== undefined ? (
            <Note>{issueReasonText(data.reason)}</Note>
          ) : detail === null ? (
            <Note>{loading ? 'Reading GitHub…' : 'Nothing came back for this issue.'}</Note>
          ) : (
            <IssueThread detail={detail} url={detail.url} now={now} />
          )}
        </div>

        <footer
          className="flex items-center gap-2 border-t px-[17px] py-1.5"
          style={{ borderColor: 'var(--border)' }}
        >
          <MessageSquare aria-hidden className="h-[12px] w-[12px] text-text-tertiary" />
          <span className="text-small text-text-tertiary">
            {detail === null
              ? 'read-only'
              : `${String(detail.comments.length + detail.moreComments)} comment${
                  detail.comments.length + detail.moreComments === 1 ? '' : 's'
                } · read-only · updated ${relativeTime((issue ?? detail).updatedAt, now)}`}
          </span>
          {issue !== null ? (
            <a
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-small text-text-secondary underline underline-offset-2 transition-colors hover:text-accent-bright"
            >
              Open on github.com
            </a>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

/**
 * The issue's description followed by its comments — the part worth reading.
 *
 * Split out from the dialog and exported so it can be rendered without a
 * fetch: everything above it is chrome and loading state, and a test that had
 * to stand up the cache to assert on a comment count would be testing the
 * wrong thing.
 */
export function IssueThread({
  detail,
  url,
  now,
}: {
  detail: GithubIssueDetail;
  url: string;
  now: number;
}): ReactElement {
  return (
    <>
      <Entry
        author={detail.author}
        at={detail.createdAt}
        now={now}
        body={detail.body}
        emptyText="No description."
      />
      {detail.comments.map(c => (
        <Comment key={c.id} comment={c} now={now} />
      ))}
      {detail.moreComments > 0 ? (
        <p className="mt-2 text-small text-text-tertiary">
          {detail.moreComments} more comment{detail.moreComments === 1 ? '' : 's'} on{' '}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-accent-bright"
          >
            github.com
          </a>
          .
        </p>
      ) : null}
    </>
  );
}

function Note({ children }: { children: string }): ReactElement {
  return <p className="py-3.75 text-center text-body text-text-tertiary">{children}</p>;
}

function Comment({ comment, now }: { comment: IssueComment; now: number }): ReactElement {
  return (
    <div className="mt-2 border-t pt-1.75" style={{ borderColor: 'var(--border)' }}>
      <Entry
        author={comment.author}
        at={comment.createdAt}
        now={now}
        body={comment.body}
        emptyText="Empty comment."
      />
    </div>
  );
}

interface EntryProps {
  author: string | null;
  at: string;
  now: number;
  body: string;
  emptyText: string;
}

/** One authored block — the issue's description, or one comment. */
function Entry({ author, at, now, body, emptyText }: EntryProps): ReactElement {
  return (
    <article>
      <div className="mb-1.5 flex items-baseline gap-2">
        {/* GitHub's own word for an account that no longer exists. */}
        <span className="text-body font-medium text-text-secondary">{author ?? 'ghost'}</span>
        <span className="text-mini text-text-tertiary">
          {at === '' ? '' : relativeTime(at, now)}
        </span>
      </div>
      {body.trim() === '' ? (
        <p className="text-body italic text-text-tertiary">{emptyText}</p>
      ) : (
        <div className="max-w-none text-body leading-[1.62] text-text-primary">
          <Markdown>{body}</Markdown>
        </div>
      )}
    </article>
  );
}
