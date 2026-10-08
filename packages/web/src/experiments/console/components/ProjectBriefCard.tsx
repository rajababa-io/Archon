import { type ReactElement, type ReactNode } from 'react';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Project, ProjectBrief } from '../primitives/project';
import { relativeTime } from '../lib/format';
import { briefParts } from '../lib/brief-links';

const FIELDS: readonly { key: keyof Omit<ProjectBrief, 'updatedAt'>; label: string }[] = [
  { key: 'why', label: 'Why' },
  { key: 'doing', label: 'Doing' },
  { key: 'where', label: 'Where' },
];

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

  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-1.75">
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
                <BriefText value={value} />
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

/**
 * A field with its web addresses clickable (#372). Each address is its own
 * element built from a parsed part, never HTML from the brief, and only
 * http(s) addresses are ever linked — see `briefParts`.
 */
function BriefText({ value }: { value: string }): ReactElement {
  return (
    <>
      {briefParts(value).map((part, i) =>
        part.kind === 'link' ? (
          <a
            key={i}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            // A long address wraps inside the card instead of pushing it wider.
            className="underline decoration-text-tertiary/50 underline-offset-2 transition-colors [overflow-wrap:anywhere] hover:text-accent-bright hover:decoration-accent-bright"
          >
            {part.label}
          </a>
        ) : (
          part.text
        )
      )}
    </>
  );
}
