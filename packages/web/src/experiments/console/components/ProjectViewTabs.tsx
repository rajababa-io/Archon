import type { ReactElement } from 'react';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { ALL_SCOPE, K } from '../store/keys';
import { Link } from 'react-router';
import { writeProjectView, type ProjectView } from '../lib/project-view';
import type { RunCounts } from '../skills/runs';

interface ProjectViewTabsProps {
  projectId: string;
  active: ProjectView;
}

const TABS: readonly {
  key: ProjectView;
  label: string;
  suffix: string;
}[] = [
  // Overview first: it is the screen that answers "what should I do next",
  // and the tabs read left to right from orientation to detail.
  { key: 'overview', label: 'Overview', suffix: '/overview' },
  { key: 'runs', label: 'Runs', suffix: '' },
  { key: 'chat', label: 'Chat', suffix: '/chat' },
  { key: 'issues', label: 'Issues', suffix: '/issues' },
  // Files last: it is the surface you go to deliberately, not the one you
  // land on to find out what happened.
  { key: 'files', label: 'Files', suffix: '/files' },
];

/**
 * The tabs All projects has: the two a project has that make sense across
 * every project, in the project's own order. Drawn by the same `ViewTab`, so
 * the two rows cannot come to look different.
 */
const ALL_PROJECTS_TABS = TABS.filter(t => t.key === 'runs' || t.key === 'chat');

/** One tab: label, its count, and the underline when it is the page. */
function ViewTab({
  to,
  label,
  count,
  isActive,
  onClick,
}: {
  to: string;
  label: string;
  count: number | null | undefined;
  isActive: boolean;
  onClick?: () => void;
}): ReactElement {
  const shown = count === null || count === undefined || count === 0 ? null : count;
  return (
    <Link
      to={to}
      onClick={onClick}
      aria-current={isActive ? 'page' : undefined}
      className={`relative rounded px-2 py-1 text-small font-medium transition-colors ${
        isActive
          ? 'bg-surface-elevated text-text-primary'
          : 'text-text-tertiary hover:text-text-primary'
      }`}
    >
      {label}
      {/* The same numbers the rail carries, in the same order. Blank for
          zero, so a quiet tab stays quiet — a `0` beside every tab is
          noise, and this row is read constantly. The label's own size
          and baseline: a smaller count sat visibly off the word's line. */}
      {shown !== null ? (
        <span className="ml-1.5 align-baseline font-normal tabular-nums opacity-70">{shown}</span>
      ) : null}
      {isActive ? (
        <span
          aria-hidden
          className="brand-bar pointer-events-none absolute inset-x-1 -bottom-0.5 h-0.5 rounded-full"
        />
      ) : null}
    </Link>
  );
}

/**
 * The project's tab control. Active styling mirrors FilterChips (brand-bar
 * underline).
 *
 * Picking a tab records it as this project's view, so returning to the project
 * later lands on the same one. The write happens on click, before navigation,
 * so choosing Runs is seen as a choice rather than bounced back to Chat.
 */
export function ProjectViewTabs({ projectId, active }: ProjectViewTabsProps): ReactElement {
  // Same cache entry the rail reads, so the two never disagree and the tab row
  // costs no extra request.
  const { data } = useEntity<skill.ProjectCounts>(K.projectCounts(projectId), () =>
    skill.getProjectCounts(projectId)
  );
  const counts: Partial<Record<ProjectView, number | null>> = {
    runs: data?.runs ?? null,
    chat: data?.chats ?? null,
    issues: data?.issues ?? null,
  };

  return (
    <div className="flex items-center gap-1">
      {TABS.map(({ key, label, suffix }) => (
        <ViewTab
          key={key}
          to={`/console/p/${projectId}${suffix}`}
          label={label}
          count={counts[key]}
          isActive={key === active}
          onClick={() => {
            writeProjectView(projectId, key);
          }}
        />
      ))}
    </div>
  );
}

/**
 * Runs | Chat across every project.
 *
 * The counts mean what a project's mean: runs in play (running, paused or
 * queued, not the lifetime total) and open chats. The chat count reads the
 * Chat tab's own open list, so the number and the rail beneath it are one
 * answer rather than two that can drift.
 */
export function AllProjectsTabs({ active }: { active: ProjectView }): ReactElement {
  const { data: runs } = useEntity<RunCounts>(K.countsGlobal, skill.listGlobalCounts);
  const { data: chats } = useEntity<skill.ConversationList>(
    `${K.conversations(ALL_SCOPE)}:open`,
    () => skill.listConversations(null, 'open')
  );
  const counts: Partial<Record<ProjectView, number | null>> = {
    runs: runs === undefined ? null : runs.running + runs.paused + runs.pending,
    chat: chats?.counts.open ?? null,
  };

  return (
    <div className="flex items-center gap-1">
      {ALL_PROJECTS_TABS.map(({ key, label, suffix }) => (
        <ViewTab
          key={key}
          to={`/console${suffix}`}
          label={label}
          count={counts[key]}
          isActive={key === active}
        />
      ))}
    </div>
  );
}
