import { ExternalLink, FileText } from 'lucide-react';
import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Markdown } from './Markdown';
import { relativeTime } from '../lib/format';
import type { OpenChatRequest } from '../lib/open-chat';
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
 */
export function ArtifactsBand({ projectId }: { projectId: string }): ReactElement {
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
              className={`rounded-full border px-2.5 py-0.5 text-mini transition-colors ${
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
              className="px-3 py-1.25 text-left text-body text-text-tertiary hover:text-text-primary"
            >
              {visible.length - shown} more
            </button>
          ) : null}
        </div>
      )}

      {open !== null ? <ArtifactPreview projectId={projectId} artifact={open} /> : null}
    </div>
  );
}

function ArtifactRow({
  artifact,
  projectId,
  active,
  onOpen,
}: {
  artifact: ProjectArtifact;
  projectId: string;
  active: boolean;
  onOpen: () => void;
}): ReactElement {
  const dot = artifactDot(artifact);
  return (
    <div
      className={`group flex items-center gap-2 border-b border-border px-3 py-1.25 last:border-b-0 ${
        active ? 'bg-surface-elevated' : 'hover:bg-surface-hover'
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={active}
        className="flex min-w-0 shrink items-center gap-2 text-left"
      >
        <FileText className="h-[14px] w-[14px] shrink-0 text-text-tertiary" />
        <span
          className={`truncate text-body ${active ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'}`}
        >
          {artifact.name}
        </span>
      </button>
      <SourceLink source={artifactSource(artifact)} projectId={projectId} />
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
    </div>
  );
}

const SOURCE_CLASS =
  'min-w-0 max-w-[45%] shrink truncate text-mini text-text-tertiary hover:text-text-primary hover:underline';

function SourceLink({
  source,
  projectId,
}: {
  source: ArtifactSource;
  projectId: string;
}): ReactElement | null {
  switch (source.kind) {
    case 'pr':
      return (
        <a href={source.url} target="_blank" rel="noopener noreferrer" className={SOURCE_CLASS}>
          · {source.label}
        </a>
      );
    case 'chat': {
      const request: OpenChatRequest = { openChat: source.chatId, done: source.done };
      return (
        <Link to={`/console/p/${projectId}/chat`} state={request} className={SOURCE_CLASS}>
          · {source.label}
        </Link>
      );
    }
    case 'run':
      return (
        <Link to={`/console/p/${projectId}/r/${source.runId}`} className={SOURCE_CLASS}>
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
}: {
  projectId: string;
  artifact: ProjectArtifact;
}): ReactElement {
  const { data: text, error } = useEntity<string>(
    K.projectArtifactText(projectId, artifact.id),
    () => skill.fetchProjectArtifact(projectId, artifact)
  );
  const isMarkdown = /\.(md|markdown)$/i.test(artifact.name);
  const runLink = artifact.run !== null ? `/console/p/${projectId}/r/${artifact.run.id}` : null;

  return (
    <section
      aria-label={`Preview of ${artifact.name}`}
      className="flex max-h-[480px] flex-col overflow-hidden rounded-lg border border-border"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.25">
        <span className="text-mini font-medium text-text-tertiary">Preview</span>
        <span className="min-w-0 truncate text-mini text-text-secondary">· {artifact.name}</span>
        <span className="flex-1" />
        {runLink !== null ? (
          <Link
            to={runLink}
            className="inline-flex shrink-0 items-center gap-1 text-mini text-text-tertiary hover:text-text-primary"
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
