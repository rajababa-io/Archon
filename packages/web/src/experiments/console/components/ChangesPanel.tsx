import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { ChangedFile, ConversationChanges, ChangeDiff } from '../skills/changes';
import { diffLines, type DiffLineKind } from '../primitives/diff-lines';

interface ChangesPanelProps {
  /** Platform id of the chat being viewed. */
  conversationId: string;
  /** Whether a turn is running — the panel refreshes when it stops. */
  working: boolean;
}

const STATUS_LETTER: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  other: '?',
};

const LINE_CLASS: Record<DiffLineKind, string> = {
  meta: 'text-text-tertiary',
  hunk: 'bg-accent/10 text-accent',
  add: 'bg-success/10 text-success',
  del: 'bg-error/10 text-error',
  context: 'text-text-secondary',
  note: 'text-text-tertiary italic',
};

/**
 * READ-ONLY view of the uncommitted changes in the checkout this chat's agent
 * runs in: which files, how many lines each way, and one file's diff at a
 * time. It has no stage, revert, or commit — acting on a change is the
 * agent's job, asked for in the chat.
 *
 * Collapsed to a narrow tab by default, showing the count, so the chat keeps
 * its width until you ask to look. Refreshes when a turn ends, because that is
 * when the agent's edits for the turn are done; between turns nothing else
 * announces a change, so the refresh button covers edits made outside the chat.
 */
export function ChangesPanel({ conversationId, working }: ChangesPanelProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, loading } = useEntity<ConversationChanges>(K.changes(conversationId), () =>
    skill.getConversationChanges(conversationId)
  );

  // Refresh on the working → idle edge, the moment a turn's edits are final.
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) invalidate(K.changes(conversationId));
    wasWorking.current = working;
  }, [working, conversationId]);

  // A selection belongs to one chat; switching chats starts from the list.
  useEffect(() => {
    setSelected(null);
  }, [conversationId]);

  // A chat with no project has no checkout: say nothing rather than
  // offering a panel that can only ever be empty.
  if (data?.state === 'unscoped') return null;

  const files = data?.state === 'ok' ? data.files : [];
  const total = data?.state === 'ok' ? files.length + data.omitted : 0;
  // The file the agent just removed from the change set is not selected any more.
  const current = files.find(f => f.path === selected) ?? null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        aria-label={`Show changes (${String(total)} files)`}
        className="flex w-8 shrink-0 flex-col items-center gap-2 border-l border-border bg-surface-inset/40 py-3 text-text-tertiary transition-colors hover:text-text-primary"
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] [writing-mode:vertical-rl]">
          Changes
        </span>
        {total > 0 ? (
          <span className="font-mono text-[11px] tabular-nums text-text-secondary">
            {String(total)}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <aside
      aria-label="Changes"
      className="flex w-[min(560px,45vw)] min-w-0 shrink-0 flex-col border-l border-border bg-surface-inset/40"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-secondary">
          Changes
        </span>
        {data?.state === 'ok' ? (
          <span
            className="min-w-0 truncate font-mono text-[11px] text-text-tertiary"
            title={data.root}
          >
            {data.branch ?? (data.head !== null ? data.head.slice(0, 8) : 'no commits')} ·
            uncommitted
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            invalidate(K.changes(conversationId));
          }}
          disabled={loading}
          className="font-mono text-[11px] text-text-tertiary transition-colors hover:text-text-primary disabled:opacity-50"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
          }}
          aria-label="Hide changes"
          className="px-1 text-text-tertiary transition-colors hover:text-text-primary"
        >
          ×
        </button>
      </header>

      {error !== undefined ? (
        <p className="px-3 py-2 font-mono text-[11px] text-error">
          Couldn&apos;t read changes: {error.message}
        </p>
      ) : data === undefined ? (
        <p className="px-3 py-2 font-mono text-[11px] text-text-tertiary">Reading…</p>
      ) : data.state === 'not-a-checkout' ? (
        <p className="px-3 py-2 text-xs text-text-secondary">
          This chat runs in <span className="font-mono">{data.path}</span>, which is not a git
          checkout, so there is no diff to show.
        </p>
      ) : data.state === 'ok' && files.length === 0 ? (
        <p className="px-3 py-2 text-xs text-text-secondary">No uncommitted changes.</p>
      ) : data.state === 'ok' ? (
        <>
          <ul className="max-h-[35%] shrink-0 overflow-y-auto border-b border-border py-1">
            {files.map(file => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(file.path);
                  }}
                  aria-current={file.path === current?.path}
                  className={`flex w-full items-center gap-2 px-3 py-0.5 text-left font-mono text-[11px] transition-colors hover:bg-surface-hover ${
                    file.path === current?.path
                      ? 'bg-surface-hover text-text-primary'
                      : 'text-text-secondary'
                  }`}
                >
                  <span className="w-3 shrink-0 text-text-tertiary" title={file.status}>
                    {STATUS_LETTER[file.status]}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={file.path}>
                    {file.oldPath !== null ? `${file.oldPath} → ${file.path}` : file.path}
                  </span>
                  <Counts file={file} />
                </button>
              </li>
            ))}
            {data.omitted > 0 ? (
              <li className="px-3 py-1 font-mono text-[11px] text-text-tertiary">
                …and {String(data.omitted)} more files not listed.
              </li>
            ) : null}
          </ul>
          {current !== null ? (
            <FileDiffView conversationId={conversationId} file={current} />
          ) : (
            <p className="px-3 py-2 text-xs text-text-tertiary">Pick a file to see its diff.</p>
          )}
        </>
      ) : null}
    </aside>
  );
}

function Counts({ file }: { file: ChangedFile }): ReactElement {
  if (file.additions === null || file.deletions === null) {
    return <span className="shrink-0 text-text-tertiary">binary</span>;
  }
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-success">+{String(file.additions)}</span>{' '}
      <span className="text-error">−{String(file.deletions)}</span>
    </span>
  );
}

function FileDiffView({
  conversationId,
  file,
}: {
  conversationId: string;
  file: ChangedFile;
}): ReactElement {
  const { data, error } = useEntity<ChangeDiff>(K.changeDiff(conversationId, file.path), () =>
    skill.getConversationChangeDiff(conversationId, file.path)
  );

  if (error !== undefined) {
    return (
      <p className="px-3 py-2 font-mono text-[11px] text-error">
        Couldn&apos;t read the diff: {error.message}
      </p>
    );
  }
  if (data === undefined) {
    return <p className="px-3 py-2 font-mono text-[11px] text-text-tertiary">Reading…</p>;
  }
  if (data.binary) {
    return <p className="px-3 py-2 text-xs text-text-secondary">Binary file — not shown.</p>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {data.patch !== '' ? (
        <pre className="min-w-max py-1 font-mono text-[11px] leading-[1.5]">
          {diffLines(data.patch).map((line, i) => (
            <div key={i} className={`px-3 ${LINE_CLASS[line.kind]}`}>
              {line.text === '' ? ' ' : line.text}
            </div>
          ))}
        </pre>
      ) : null}
      {data.truncated ? (
        <p className="border-t border-border px-3 py-2 text-xs text-warning">
          {data.patch === ''
            ? 'This diff is too large to show here.'
            : 'Diff cut short — too long to show whole here.'}
        </p>
      ) : null}
    </div>
  );
}
