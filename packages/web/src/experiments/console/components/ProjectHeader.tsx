import type { ReactElement } from 'react';
import { useLocation, useParams } from 'react-router';
import { AllProjectsTabs, ProjectViewTabs } from './ProjectViewTabs';
import { DeployStrip } from './DeployStrip';
import { DeployRow } from './DeployRow';
import { DeploySetupRow } from './DeploySetupRow';
import { ProjectStateChip } from './ProjectStateChip';
import { useProjectLabel } from '../lib/display-name';
import { Glyph } from '../lib/glyph';
import { useProjectIdentity } from '../lib/project-identity';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Project } from '../primitives/project';
import type { DeployAnswer } from '../skills/deploy';
import type { RunCounts } from '../skills/runs';
import {
  activeProjectTab,
  activityNeedsYou,
  activitySummary,
  allProjectsSubtitle,
  headerPathLabel,
} from '../lib/project-header';

interface FeedShape {
  counts: RunCounts;
}

/**
 * The project header, rendered once by the layout rather than by each page.
 *
 * It used to be duplicated in RunsPage and ChatPage and absent from the run
 * detail — so opening a run replaced the whole header, taking the path and the
 * Runs/Chat tabs with it, and a run that failed to load left a bare error on an
 * empty page with no way back.
 *
 * Its height is fixed in every state on purpose: name, then tabs. A header
 * that grows or shrinks between screens shifts everything below it, which is
 * the thing being fixed here rather than a detail of it.
 *
 * The path rides the right end of the tab row rather than owning a line of its
 * own. That line was mostly a constant workspaces prefix and a second printing
 * of the name above it, and the tab row had the width spare.
 *
 * The mark and the name are the rail row's, drawn larger. The rail is a list
 * you scan and the header answers "where am I", so the same identity has to
 * appear in both — the header carried only the name, which left the icon
 * looking like a property of the list rather than of the project.
 *
 * Every project gets one more row, between the name and the tabs: its deploy
 * bar (see DeployRow), or the not-set-up bar that offers to add one (see
 * DeploySetupRow), both the same height. The one moment it can move the page
 * is the first visit before the answer lands; after that the cached answer
 * reserves it on the first frame.
 *
 * The name is the repo alone. `owner/repo` above a path that already spells
 * the owner out said it twice and left the distinguishing half truncated;
 * the full name is still on the title attribute for anyone who wants it.
 */
export function ProjectHeader(): ReactElement {
  const { projectId } = useParams<{ projectId?: string }>();
  const { pathname } = useLocation();
  const scope = projectId ?? 'all';
  // Seeded by the project id, so the mark is already correct on the first
  // frame — waiting for the fetch would pop an icon in beside the name.
  const { identity, color } = useProjectIdentity(projectId ?? '');

  // Same cache keys the pages use, so this is a read of data already fetched
  // rather than a second request per navigation.
  const { data: project } = useEntity<Project | null>(
    projectId === undefined ? 'noop:all-projects' : K.project(projectId),
    () => (projectId === undefined ? Promise.resolve(null) : skill.getProject(projectId))
  );
  const { data: feed } = useEntity<FeedShape>(K.runs(scope), () =>
    skill.listRuns(
      projectId === undefined
        ? { limit: skill.RUN_LIMIT }
        : { codebaseId: projectId, limit: skill.RUN_LIMIT }
    )
  );
  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  const { data: deploy } = useEntity<DeployAnswer | null>(
    projectId === undefined ? 'noop:all-projects:deploy' : K.projectDeploy(projectId),
    () => (projectId === undefined ? Promise.resolve(null) : skill.getProjectDeploy(projectId))
  );
  // The install-wide strip is this Archon install's own deploy, so it belongs
  // only where no project is in view. Beside another project's name it reads as
  // that project's deploy — a red "Deploy failed" on a project that never
  // deployed (#319). The archon-host project's own row already carries it.
  const showStrip = projectId === undefined;

  // Renaming in the rail reaches the header through the same override store,
  // so the two can never disagree about what this project is called.
  const label = useProjectLabel(projectId ?? '', project?.name ?? '');

  const counts = feed?.counts ?? null;
  const activity = activitySummary(counts);
  const needsYou = activityNeedsYou(counts);

  return (
    <header className="flex shrink-0 flex-col gap-x-2.25 gap-y-1.75 border-b border-border px-4.75 pb-0 pt-2.5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          {projectId !== undefined ? (
            <span aria-hidden className="flex shrink-0 items-center">
              <Glyph seed={projectId} glyph={identity.glyph} color={color} size={24} />
            </span>
          ) : null}
          <h1
            title={project?.name}
            className="self-baseline truncate text-title font-semibold text-text-primary"
          >
            {projectId === undefined ? 'All projects' : label === '' ? 'Project' : label}
          </h1>
          {/* Whether this project wants something. Beside the name because
                it is a property of the project, not of the page — and absent
                entirely when the answer is no. */}
          {projectId !== undefined ? <ProjectStateChip projectId={projectId} /> : null}
        </span>

        {/* Install-wide, in space this row was already spending on nothing.
            See components/DeployStrip for why it is here rather than in a band
            of its own, and what that placement costs. */}
        {showStrip ? <DeployStrip /> : null}

        {activity !== null ? (
          <span
            className="flex shrink-0 items-center gap-1.5 text-mini font-medium"
            // --brand-* are fills with no light-mode value; text must use the
            // semantic tokens, which are tuned per mode and verified at AA.
            style={{ color: needsYou ? 'var(--warning)' : 'var(--running)' }}
          >
            {/* `live-mark` only while something is actually executing: a needs-you
                pill is waiting, and a waiting thing that pulses is asking to be
                looked at twice. */}
            <span
              aria-hidden
              className={`h-[6px] w-[6px] rounded-full bg-current${needsYou ? '' : ' live-mark'}`}
            />
            {activity}
          </span>
        ) : null}
      </div>

      {projectId !== undefined && deploy?.kind === 'set-up' ? (
        <DeployRow
          projectId={projectId}
          projectName={label === '' ? 'Project' : label}
          deploy={deploy.deploy}
        />
      ) : null}
      {projectId !== undefined && deploy?.kind === 'not-set-up' ? (
        <DeploySetupRow projectId={projectId} setup={deploy.setup} canAct={deploy.canAct} />
      ) : null}

      {/* One min-height governs both states, so no project scoped cannot make
          the header a different height from a project that is. A spacer sized
          to match the tab row by hand held that invariant before, and had
          already drifted 1.5px off the tabs it was copying. */}
      <div className="flex min-h-[26px] items-end justify-between gap-3">
        {projectId === undefined ? (
          <>
            <AllProjectsTabs active={activeProjectTab(pathname)} />
            {/* In the place a project's path sits: the second line of context. */}
            <p className="min-w-0 truncate pb-1 text-small text-text-tertiary">
              {allProjectsSubtitle(projects?.length ?? 0, counts)}
            </p>
          </>
        ) : (
          <>
            <ProjectViewTabs projectId={projectId} active={activeProjectTab(pathname)} />
            {/* The checkout, in the width the tabs leave. Rendered while loading
                too — this corner holds the header's second line of context in
                every state. The trimmed label is what you read; the full path
                stays on the title for anyone who wants all of it. */}
            <p
              title={project?.path}
              className="min-w-0 truncate pb-1 text-small text-text-tertiary"
            >
              {project?.path === undefined ? 'Loading…' : headerPathLabel(project.path)}
            </p>
          </>
        )}
      </div>
    </header>
  );
}
