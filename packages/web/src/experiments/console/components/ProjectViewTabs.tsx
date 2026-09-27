import type { ReactElement } from 'react';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { Link } from 'react-router';
import { writeProjectView, type ProjectView } from '../lib/project-view';

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
 * Runs | Chat tab control under a project. Active styling mirrors FilterChips
 * (brand-bar underline). Only meaningful when a project is scoped — chat is
 * project-scoped, so this is never rendered on the All-projects view.
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
  const counts = {
    runs: data?.runs ?? null,
    chats: data?.chats ?? null,
    issues: data?.issues ?? null,
  };

  return (
    <div className="flex items-center gap-1">
      {TABS.map(({ key, label, suffix }) => {
        const isActive = key === active;
        const raw =
          key === 'runs'
            ? counts.runs
            : key === 'chat'
              ? counts.chats
              : key === 'issues'
                ? counts.issues
                : null;
        const count = raw === null || raw === undefined || raw === 0 ? null : raw;
        return (
          <Link
            key={key}
            to={`/console/p/${projectId}${suffix}`}
            onClick={() => {
              writeProjectView(projectId, key);
            }}
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
            {count !== null ? (
              <span className="ml-1.5 align-baseline font-normal tabular-nums opacity-70">
                {count}
              </span>
            ) : null}
            {isActive ? (
              <span
                aria-hidden
                className="brand-bar pointer-events-none absolute inset-x-1 -bottom-0.5 h-0.5 rounded-full"
              />
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
