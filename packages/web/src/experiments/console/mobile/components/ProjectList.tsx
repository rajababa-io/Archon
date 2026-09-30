import { useMemo, type ReactElement } from 'react';
import { Link } from 'react-router';
import { applyManualOrder } from '../../lib/chat-order';
import { readProjectOrder } from '../../lib/project-order';
import { useProjectIdentity } from '../../lib/project-identity';
import { ProjectCountCells, ProjectCountHeader } from '../../components/ProjectCountCells';
import { groupByOwner } from '../../primitives/project';
import { projectPath } from '../lib/paths';
import { ProjectMark } from './ProjectMark';
import type { MobileChats } from '../lib/use-mobile-chats';

/**
 * Every registered project, laid out as the desktop rail lays it out (#305):
 * the rail's order, grouped by owner, each row the project's coloured icon,
 * its name, and the rail's three counts — chats, runs, open issues. Every
 * project is here, chats or none, so a quiet one still has a way in (#292).
 */
interface ProjectListProps {
  chats: MobileChats;
  /** The project you are in, marked in its own colour. */
  currentProjectId?: string;
  /** Picking a project; the link itself navigates. */
  onPick?: () => void;
}

export function ProjectList({ chats, currentProjectId, onPick }: ProjectListProps): ReactElement {
  const { projects, projectsError, reach, projectLabel } = chats;
  // The rail's own order and grouping, so the two surfaces list projects alike.
  const groups = useMemo(
    () => groupByOwner(applyManualOrder(projects ?? [], readProjectOrder())),
    [projects]
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
  } else if (groups.length === 0) {
    body = <p className="mobile-note">No projects registered.</p>;
  } else {
    body = (
      <>
        {groups.map(group => (
          <section key={group.owner} aria-label={group.owner}>
            <h3 className="px-4 pt-2 pb-1 text-small font-medium text-text-tertiary">
              {group.owner}
            </h3>
            <ul>
              {group.items.map(project => (
                <li key={project.id}>
                  <ProjectListRow
                    projectId={project.id}
                    label={projectLabel(project.id)}
                    current={project.id === currentProjectId}
                    onPick={onPick}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </>
    );
  }

  return (
    <nav aria-label="Projects">
      <h2 className="flex min-h-11 items-center gap-2 pr-4 pl-4 text-mini font-medium text-text-tertiary uppercase">
        <span className="flex-1">Projects</span>
        {projects !== undefined && groups.length > 0 ? <ProjectCountHeader /> : null}
      </h2>
      {body}
    </nav>
  );
}

function ProjectListRow({
  projectId,
  label,
  current,
  onPick,
}: {
  projectId: string;
  label: string;
  current: boolean;
  onPick?: () => void;
}): ReactElement {
  const { color } = useProjectIdentity(projectId);
  return (
    <Link
      to={projectPath(projectId)}
      onClick={onPick}
      aria-current={current ? 'page' : undefined}
      className="mobile-row mx-2 flex items-center gap-3 rounded-[10px] px-2 aria-[current=page]:bg-surface-elevated"
      style={current ? { boxShadow: `inset 4px 0 0 ${color}` } : undefined}
    >
      <ProjectMark projectId={projectId} />
      <span className="min-w-0 flex-1 truncate text-body text-text-primary">{label}</span>
      <ProjectCountCells projectId={projectId} />
    </Link>
  );
}
