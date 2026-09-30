import { useMemo, type ReactElement } from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { projectPath } from '../lib/paths';
import { projectRows } from '../lib/switcher';
import type { MobileChats } from '../lib/use-mobile-chats';

/**
 * Every registered project, each a way into its screen (#292). The chat list
 * below only names projects that have chats, so without this a quiet project
 * cannot be reached from the phone at all.
 */
interface ProjectListProps {
  chats: MobileChats;
  /** Picking a project; the link itself navigates. */
  onPick?: () => void;
}

export function ProjectList({ chats, onPick }: ProjectListProps): ReactElement {
  const { projects, projectsError, reach, projectLabel } = chats;
  const rows = useMemo(
    () =>
      projectRows(
        (projects ?? []).map(p => p.id),
        chats.chats ?? [],
        projectLabel
      ),
    [projects, chats.chats, projectLabel]
  );

  let body: ReactElement;
  if (projects === undefined) {
    // Say why the section is empty rather than letting it vanish.
    body =
      reach !== 'online' ? (
        <p className="mobile-note">Projects can&apos;t load while Archon is out of reach.</p>
      ) : projectsError !== undefined ? (
        <p className="mobile-note text-error">
          Couldn&apos;t load projects: {projectsError.message}
        </p>
      ) : (
        <p className="mobile-note">Loading projects…</p>
      );
  } else if (rows.length === 0) {
    body = <p className="mobile-note">No projects registered.</p>;
  } else {
    body = (
      <ul>
        {rows.map(({ projectId, open }) => (
          <li key={projectId}>
            <Link
              to={projectPath(projectId)}
              onClick={onPick}
              className="mobile-row flex items-center gap-3 px-4"
            >
              <span className="min-w-0 flex-1 truncate text-body text-text-primary">
                {projectLabel(projectId)}
              </span>
              <span className="shrink-0 text-small text-text-tertiary">
                {open === 0 ? 'No open chats' : open === 1 ? '1 open chat' : `${open} open chats`}
              </span>
              <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <nav aria-label="Projects">
      <h2 className="flex min-h-11 items-center px-4 text-mini font-medium text-text-tertiary uppercase">
        Projects
      </h2>
      {body}
    </nav>
  );
}
