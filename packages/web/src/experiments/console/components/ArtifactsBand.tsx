import { ExternalLink, FileText } from 'lucide-react';
import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Markdown } from './Markdown';
import { relativeTime } from '../lib/format';
import type { OpenChatRequest } from '../lib/open-chat';
import { chatPath, runPath } from '../mobile/lib/paths';
import {
  ARTIFACT_FILTERS,
  artifactDot,
  artifactSource,
  filterArtifacts,
  type ArtifactSource,
} from '../primitives/project-artifact';
import * as skill from '../skills';
import type { ProjectArtifact, ProjectArtifactType } from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';

/** Rows shown before "Show more"; each press adds this many again. */
const PAGE = 8;

/**
 * The project's documents — plans, investigations, reviews, handoffs, data —
 * across every run and handoff, newest first (#351). Select one to read it
 * here; its source links back to the PR, chat or run that produced it.
 *
 * `phone` is the layout for a finger: every control at least 44px, and each
 * row one tap target — the source link moves into the preview header, because
 * a link inside a row is too small to hit beside the row itself. Links then go
 * to the phone's own screens.
 */
export function ArtifactsBand({
  projectId,
  phone = false,
}: {
  projectId: string;
  phone?: boolean;
}): ReactElement {
  const { data, error } = useEntity<ProjectArtifact[]>(K.projectArtifacts(projectId), () =>
    skill.listProjectArtifacts(projectId)
  );
  const [selected, setSelected] = useState<ReadonlySet<ProjectArtifactType>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  const visible = useMemo(() => filterArtifacts(data ?? [], selected), [data, selected]);
  const open = visible.find(a => a.id === openId) ?? null;

  const toggle = (type: ProjectArtifactType): void => {
    const next = new Set(selected);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setSelected(next);
    setShown(PAGE);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter artifacts by type">
        {ARTIFACT_FILTERS.map(({ type, label }) => {
          const on = selected.has(type);
          return (
            <button
              key={type}
              type="button"
              aria-pressed={on}
              onClick={() => {
                toggle(type);
              }}
              className={`rounded-full border transition-colors ${
                phone ? 'min-h-11 px-3.5 text-body' : 'px-2.5 py-0.5 text-mini'
              } ${
                on
                  ? 'border-border-bright bg-surface-elevated text-text-primary'
                  : 'border-border text-text-secondary hover:border-border-bright hover:text-text-primary'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {error !== undefined ? (
        <p className="text-body text-[color:var(--error)]">Could not load artifacts.</p>
      ) : data === undefined ? (
        <p className="text-body text-text-tertiary">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-body text-text-tertiary">
          {selected.size === 0 ? 'No documents yet.' : 'Nothing of that type yet.'}
        </p>
      ) : (
        <div className="flex flex-col overflow-hidden rounded-lg border border-border">
          {visible.slice(0, shown).map(a => (
            <ArtifactRow
              key={a.id}
              artifact={a}
              projectId={projectId}
              phone={phone}
              active={a.id === openId}
              onOpen={() => {
                setOpenId(a.id === openId ? null : a.id);
              }}
            />
          ))}
          {visible.length > shown ? (
            <button
              type="button"
              onClick={() => {
                setShown(n => n + PAGE);
              }}
              className={`px-3 text-left text-body text-text-tertiary hover:text-text-primary ${
                phone ? 'min-h-11' : 'py-1.25'
              }`}
            >
              {visible.length - shown} more
            </button>
          ) : null}
        </div>
      )}

      {open !== null ? (
        <ArtifactPreview projectId={projectId} artifact={open} phone={phone} />
      ) : null}
    </div>
  );
}

function ArtifactRow({
  artifact,
  projectId,
  phone,
  active,
  onOpen,
}: {
  artifact: ProjectArtifact;
  projectId: string;
  phone: boolean;
  active: boolean;
  onOpen: () => void;
}): ReactElement {
  const dot = artifactDot(artifact);
  const source = artifactSource(artifact);
  const name = (
    <>
      <FileText className="h-[14px] w-[14px] shrink-0 text-text-tertiary" />
      <span
        className={`truncate text-body ${active ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'}`}
      >
        {artifact.name}
      </span>
    </>
  );
  const tail = (
    <>
      <time dateTime={artifact.modifiedAt} className="shrink-0 text-mini text-text-tertiary">
        · {relativeTime(artifact.modifiedAt)}
      </time>
      <span className="flex-1" />
      <span
        role="img"
        aria-label={dot.title}
        title={dot.title}
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: dot.color }}
      />
    </>
  );
  const rowClass = `group flex w-full items-center gap-2 border-b border-border px-3 last:border-b-0 ${
    active ? 'bg-surface-elevated' : 'hover:bg-surface-hover'
  }`;

  if (phone) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={active}
        className={`${rowClass} min-h-11 text-left`}
      >
        {name}
        {source.kind !== 'none' ? (
          <span className="min-w-0 max-w-[40%] shrink truncate text-mini text-text-tertiary">
            · {source.label}
          </span>
        ) : null}
        {tail}
      </button>
    );
  }
  return (
    <div className={`${rowClass} py-1.25`}>
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={active}
        className="flex min-w-0 shrink items-center gap-2 text-left"
      >
        {name}
      </button>
      <SourceLink source={source} projectId={projectId} phone={false} className={SOURCE_CLASS} />
      {tail}
    </div>
  );
}

const SOURCE_CLASS =
  'min-w-0 max-w-[45%] shrink truncate text-mini text-text-tertiary hover:text-text-primary hover:underline';

function SourceLink({
  source,
  projectId,
  phone,
  className,
}: {
  source: ArtifactSource;
  projectId: string;
  phone: boolean;
  className: string;
}): ReactElement | null {
  switch (source.kind) {
    case 'pr':
      return (
        <a href={source.url} target="_blank" rel="noopener noreferrer" className={className}>
          · {source.label}
        </a>
      );
    case 'chat': {
      if (phone) {
        return (
          <Link to={chatPath(source.chatId)} className={className}>
            · {source.label}
          </Link>
        );
      }
      const request: OpenChatRequest = { openChat: source.chatId, done: source.done };
      return (
        <Link to={`/console/p/${projectId}/chat`} state={request} className={className}>
          · {source.label}
        </Link>
      );
    }
    case 'run':
      return (
        <Link
          to={phone ? runPath(source.runId) : `/console/p/${projectId}/r/${source.runId}`}
          className={className}
        >
          · {source.label}
        </Link>
      );
    case 'none':
      return null;
  }
}

function ArtifactPreview({
  projectId,
  artifact,
  phone,
}: {
  projectId: string;
  artifact: ProjectArtifact;
  phone: boolean;
}): ReactElement {
  const { data: text, error } = useEntity<string>(
    K.projectArtifactText(projectId, artifact.id),
    () => skill.fetchProjectArtifact(projectId, artifact)
  );
  const isMarkdown = /\.(md|markdown)$/i.test(artifact.name);
  const runLink =
    artifact.run === null
      ? null
      : phone
        ? runPath(artifact.run.id)
        : `/console/p/${projectId}/r/${artifact.run.id}`;
  const tapHeight = phone ? 'min-h-11' : '';

  return (
    <section
      aria-label={`Preview of ${artifact.name}`}
      className="flex max-h-[480px] flex-col overflow-hidden rounded-lg border border-border"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.25">
        <span className="text-mini font-medium text-text-tertiary">Preview</span>
        <span className="min-w-0 truncate text-mini text-text-secondary">· {artifact.name}</span>
        <span className="flex-1" />
        {phone ? (
          <SourceLink
            source={artifactSource(artifact)}
            projectId={projectId}
            phone
            className={`inline-flex min-w-11 max-w-[45%] shrink items-center truncate text-mini text-text-tertiary hover:text-text-primary ${tapHeight}`}
          />
        ) : null}
        {runLink !== null ? (
          <Link
            to={runLink}
            className={`inline-flex shrink-0 items-center gap-1 text-mini text-text-tertiary hover:text-text-primary ${tapHeight}`}
          >
            Open run
            <ExternalLink className="h-3 w-3" />
          </Link>
        ) : null}
      </header>
      <div className="min-h-0 overflow-y-auto px-3 py-2">
        {error !== undefined ? (
          <p className="text-body text-[color:var(--error)]">{error.message}</p>
        ) : text === undefined ? (
          <p className="text-body text-text-tertiary">Loading…</p>
        ) : isMarkdown ? (
          <Markdown>{text}</Markdown>
        ) : (
          <pre className="whitespace-pre-wrap break-words text-mini leading-relaxed text-text-primary">
            {text}
          </pre>
        )}
      </div>
    </section>
  );
}
