import { ImageOff } from 'lucide-react';
import { type ReactElement, type ReactNode } from 'react';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { ProjectPicture, ProjectPictures } from '../skills';
import type { BriefPicture, Project, ProjectBrief } from '../primitives/project';
import { relativeTime } from '../lib/format';
import { splitBriefLinks } from '../lib/brief-links';

const FIELDS: readonly {
  key: keyof Omit<ProjectBrief, 'pictures' | 'updatedAt'>;
  label: string;
}[] = [
  { key: 'why', label: 'Why' },
  { key: 'doing', label: 'Doing' },
  { key: 'where', label: 'Where' },
];

/**
 * A brief field with its addresses clickable (#371). Text runs are React text
 * nodes, never HTML — the brief is agent-written and is not trusted markup.
 */
export function BriefText({ text }: { text: string }): ReactElement {
  return (
    <>
      {splitBriefLinks(text).map((seg, i) =>
        seg.kind === 'text' ? (
          seg.text
        ) : (
          <a
            key={i}
            href={seg.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-text-tertiary/50 underline-offset-2 wrap-anywhere transition-colors hover:text-accent-bright hover:decoration-accent-bright"
          >
            {seg.label}
          </a>
        )
      )}
    </>
  );
}

export interface ShownPicture {
  picture: ProjectPicture;
  caption: string;
}

/**
 * The brief's pictures that the server still lists, in the brief's order and
 * with the brief's captions. A picture deleted since the agent chose it is
 * left out rather than drawn as a broken tile.
 */
export function shownPictures(
  chosen: readonly BriefPicture[],
  listed: readonly ProjectPicture[]
): ShownPicture[] {
  const byPath = new Map(listed.map(p => [p.path, p]));
  return chosen.flatMap(c => {
    const picture = byPath.get(c.path);
    return picture === undefined ? [] : [{ picture, caption: c.caption }];
  });
}

/**
 * A thumbnail, or a placeholder when the server could not make one — never the
 * original, which is the download the thumbnails exist to avoid.
 */
function Thumb({ shown, className }: { shown: ShownPicture; className: string }): ReactElement {
  return shown.picture.thumbUrl !== null ? (
    <img
      src={shown.picture.thumbUrl}
      alt={shown.caption}
      loading="lazy"
      decoding="async"
      className={className}
    />
  ) : (
    <div className={`flex items-center justify-center text-text-tertiary ${className}`}>
      <ImageOff className="h-5 w-5" aria-label="No preview" />
    </div>
  );
}

/**
 * The first picture large, the rest as a row of thumbnails beneath it that
 * scrolls sideways when it outgrows the card. Each opens full size in a new tab.
 */
export function BriefPictureStrip({
  shown,
}: {
  shown: readonly ShownPicture[];
}): ReactElement | null {
  const [lead, ...rest] = shown;
  if (lead === undefined) return null;
  return (
    <div className="mb-2.5 flex flex-col gap-2">
      <a
        href={lead.picture.url}
        target="_blank"
        rel="noopener noreferrer"
        title={lead.picture.path}
        className="group flex flex-col overflow-hidden rounded-md border border-border bg-surface-elevated transition-colors hover:border-border-bright"
      >
        <Thumb shown={lead} className="max-h-[320px] w-full bg-surface object-contain" />
        <span className="border-t border-border px-2.5 py-1.25 text-small text-text-secondary group-hover:text-text-primary">
          {lead.caption}
        </span>
      </a>
      {rest.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          {rest.map(s => (
            <a
              key={s.picture.path}
              href={s.picture.url}
              target="_blank"
              rel="noopener noreferrer"
              title={s.picture.path}
              className="group flex w-[132px] shrink-0 flex-col overflow-hidden rounded-md border border-border bg-surface-elevated transition-colors hover:border-border-bright"
            >
              <Thumb
                shown={s}
                className="aspect-[16/10] w-full bg-surface object-cover object-top"
              />
              <span className="truncate border-t border-border px-2 py-1 text-mini text-text-secondary group-hover:text-text-primary">
                {s.caption}
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Said when the pictures could not be fetched, so a card the agent gave
 * pictures never reads as one it did not.
 */
export function BriefPicturesUnavailable(): ReactElement {
  return (
    <p className="mb-2.5 flex items-center gap-1.5 text-mini text-text-tertiary">
      <ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      This brief&apos;s pictures could not be loaded.
    </p>
  );
}

/**
 * The brief's pictures, fetched through the Pictures listing so each comes
 * with its thumbnail and is confirmed to still be this project's. Nothing is
 * drawn until that answers: the text below does not wait on it.
 */
function BriefPictures({
  projectId,
  pictures,
}: {
  projectId: string;
  pictures: readonly BriefPicture[];
}): ReactElement | null {
  const paths = pictures.map(p => p.path);
  const { data, error } = useEntity<ProjectPictures>(K.briefPictures(projectId, paths), () =>
    skill.listProjectPictures(projectId, { limit: paths.length, paths })
  );
  if (data === undefined) return error !== undefined ? <BriefPicturesUnavailable /> : null;
  return <BriefPictureStrip shown={shownPictures(pictures, data.pictures)} />;
}

/**
 * The standing answer to "what is this and where is it".
 *
 * Three labeled parts rather than a paragraph. The split is what keeps it
 * honest: the part that goes out of date is visibly a different field from the
 * part that does not, so a stale "Doing" cannot quietly discredit a "Why" that
 * is still true.
 *
 * READ-ONLY, deliberately. The brief is written by the agent from the repo,
 * the run history and the open issues — a field the reader can also type into
 * is a field nobody can trust, because it stops being clear whether what you
 * are reading was observed or asserted.
 *
 * It rides in on the project row (`presentation.brief`), so there is no second
 * request and nothing to sync between machines.
 */
export function ProjectBriefCard({
  projectId,
  badge,
}: {
  projectId: string;
  /** Rides under the brief — the Overview's "Needs you" count (#348). */
  badge?: ReactNode;
}): ReactElement | null {
  const { data: projects } = useEntity<Project[]>(K.projects, skill.listProjects);
  const brief = projects?.find((p: Project) => p.id === projectId)?.brief ?? null;

  if (brief === null) {
    // Says what it is rather than offering a text box: there is nothing for
    // the reader to do here, and pretending otherwise wastes a click.
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-3 py-1.75">
        <p className="text-body text-text-tertiary">
          Not written yet. This is filled in from the repository, the runs and the open issues.
        </p>
        {badge}
      </div>
    );
  }

  return <ProjectBriefView projectId={projectId} brief={brief} badge={badge} />;
}

/** A written brief: its pictures, if it has any, then the three parts. */
export function ProjectBriefView({
  projectId,
  brief,
  badge,
}: {
  projectId: string;
  brief: ProjectBrief;
  badge?: ReactNode;
}): ReactElement {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-1.75">
      {brief.pictures.length > 0 ? (
        <BriefPictures projectId={projectId} pictures={brief.pictures} />
      ) : null}
      <div className="flex flex-col gap-x-2 gap-y-1.5">
        {FIELDS.map(({ key, label }) => {
          const value = brief[key];
          if (value.trim() === '') return null;
          return (
            <div key={key} className="flex gap-2.25">
              <span className="w-[42px] shrink-0 pt-px text-mini font-medium text-text-tertiary">
                {label}
              </span>
              <span className="min-w-0 flex-1 text-body leading-[1.6] text-text-secondary">
                <BriefText text={value} />
              </span>
            </div>
          );
        })}
      </div>
      {badge !== undefined && badge !== null ? <div className="mt-2">{badge}</div> : null}
      {brief.updatedAt !== null ? (
        <p className="mt-2.5 border-t border-border pt-1.25 text-mini text-text-tertiary">
          Written {relativeTime(new Date(brief.updatedAt).toISOString())}
        </p>
      ) : null}
    </div>
  );
}
