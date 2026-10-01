import { ArrowRight, ArrowUpRight, ImageOff } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import * as skill from '../skills';
import type { ProjectPicture, ProjectPictures, ProjectPictureTopic } from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { pictureAge, pictureCaption, topicLabel } from '../lib/picture-caption';
import { useNow } from '../lib/clock';

/** Topic chips beside All on the Overview band — the most recently used ones. */
const BAND_TOPIC_CHIPS = 4;

/**
 * One picture: its thumbnail, its caption and age. Opens the full-size file in
 * a new tab — the only place the original is ever fetched.
 *
 * The thumbnail is the server's small WebP. When there is none (a build that
 * cannot make them, a file it could not read) the tile is a placeholder, NOT
 * the original: falling back to the full-size file would quietly bring back the
 * download the thumbnails exist to avoid.
 */
export function PictureTile({
  picture,
  now,
}: {
  picture: ProjectPicture;
  now: number;
}): ReactElement {
  const caption = pictureCaption(picture);
  return (
    <a
      href={picture.url}
      target="_blank"
      rel="noopener noreferrer"
      title={picture.path}
      className="group flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-elevated transition-colors hover:border-border-bright"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-surface">
        {picture.thumbUrl !== null ? (
          <img
            src={picture.thumbUrl}
            alt={caption}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-text-tertiary">
            <ImageOff className="h-5 w-5" aria-label="No preview" />
          </div>
        )}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
          <span className="inline-flex items-center gap-1 rounded-md border border-border-bright bg-surface/90 px-2 py-0.5 text-small text-text-primary">
            open full size
            <ArrowUpRight className="h-3 w-3" />
          </span>
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 border-t border-border px-2.5 py-1.25">
        <span className="min-w-0 truncate text-small text-text-secondary group-hover:text-text-primary">
          {caption}
        </span>
        <time dateTime={picture.modifiedAt} className="shrink-0 text-mini text-text-tertiary">
          · {pictureAge(picture.modifiedAt, now)}
        </time>
      </div>
    </a>
  );
}

/**
 * All, then topic folders, most recently used first. `null` is All.
 *
 * Only the first `shown` topics are chips until asked for the rest — a project
 * has as many topics as it has had pieces of work, and a wall of them buries
 * the pictures. The picked topic always shows, even past the cut: a filter you
 * cannot see is a filter you cannot clear.
 */
export function TopicChips({
  topics,
  value,
  onChange,
  shown,
}: {
  topics: readonly ProjectPictureTopic[];
  value: string | null;
  onChange: (next: string | null) => void;
  shown: number;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const head = expanded ? topics : topics.slice(0, shown);
  const picked = topics.find(t => t.name === value);
  const visible =
    picked !== undefined && !head.some(t => t.name === picked.name) ? [...head, picked] : head;
  const hidden = topics.length - head.length;
  const chipClass = (active: boolean): string =>
    `inline-flex h-[20px] shrink-0 items-center rounded-full border px-2 text-mini font-medium transition-colors ${
      active
        ? 'border-border-bright bg-surface-hover text-text-primary'
        : 'border-border text-text-tertiary hover:border-border-bright hover:text-text-secondary'
    }`;
  const chip = (key: string, label: string, pick: string | null): ReactElement => (
    <button
      key={key}
      type="button"
      aria-pressed={value === pick}
      onClick={() => {
        onChange(pick);
      }}
      className={chipClass(value === pick)}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap gap-1.5">
      {chip('', 'All', null)}
      {visible.map(t => chip(t.name, topicLabel(t.name), t.name))}
      {hidden > 0 || expanded ? (
        <button
          type="button"
          onClick={() => {
            setExpanded(e => !e);
          }}
          className="inline-flex h-[20px] shrink-0 items-center px-1 text-mini text-text-tertiary hover:text-text-primary"
        >
          {expanded ? 'fewer' : `+${String(hidden)} more`}
        </button>
      ) : null}
    </div>
  );
}

export function PictureGrid({
  pictures,
  now,
}: {
  pictures: readonly ProjectPicture[];
  now: number;
}): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
      {pictures.map(p => (
        <PictureTile key={p.path} picture={p} now={now} />
      ))}
    </div>
  );
}

/**
 * The Overview's Pictures band (#350): the project's newest pictures, a few
 * topic chips, and the way to the full gallery. Scoped to the project by the
 * server — see `services/project-pictures.ts` for the rule.
 */
export function PicturesBand({ projectId }: { projectId: string }): ReactElement {
  const [topic, setTopic] = useState<string | null>(null);
  const now = useNow();
  const { data, error } = useEntity<ProjectPictures>(
    K.pictures(projectId, topic ?? '', skill.PICTURES_BAND_SIZE, 0),
    () => skill.listProjectPictures(projectId, { limit: skill.PICTURES_BAND_SIZE, topic })
  );

  const galleryHref = `/console/p/${projectId}/pictures${
    topic !== null ? `?topic=${encodeURIComponent(topic)}` : ''
  }`;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-mini font-medium text-text-tertiary">
          Pictures{data !== undefined ? ` · ${String(data.all)}` : ''}
        </h2>
        {data !== undefined && data.total > data.pictures.length ? (
          <Link
            to={galleryHref}
            className="ml-auto inline-flex items-center gap-1 text-mini text-text-secondary hover:text-text-primary"
          >
            See all {data.total}
            <ArrowRight className="h-3 w-3" />
          </Link>
        ) : null}
      </div>
      {error !== undefined ? (
        <p className="text-body text-text-tertiary">Could not read the pictures: {error.message}</p>
      ) : data === undefined ? (
        <p className="text-body text-text-tertiary">Loading…</p>
      ) : data.all === 0 ? (
        <p className="text-body text-text-tertiary">No pictures published for this project yet.</p>
      ) : (
        <>
          {data.topics.length > 0 ? (
            <TopicChips
              topics={data.topics}
              value={topic}
              onChange={setTopic}
              shown={BAND_TOPIC_CHIPS}
            />
          ) : null}
          <PictureGrid pictures={data.pictures} now={now} />
        </>
      )}
    </section>
  );
}
