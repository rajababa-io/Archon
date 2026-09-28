import type { ReactElement } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import * as skill from '../../skills';
import { useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import type { Project } from '../../primitives/project';
import { useProjectLabel } from '../../lib/display-name';
import { ScreenHeader } from '../components/ScreenHeader';
import { ProjectMute } from '../components/NotifyControls';
import { OverviewTab } from '../components/project/OverviewTab';
import { RunsTab } from '../components/project/RunsTab';
import { ChatsTab } from '../components/project/ChatsTab';
import { IssuesTab } from '../components/project/IssuesTab';
import { FilesTab } from '../components/project/FilesTab';
import { PROJECT_TABS, parseProjectTab, projectPath, type ProjectTab } from '../lib/paths';
import { useMobileChats, type MobileChats } from '../lib/use-mobile-chats';

/** `/m/p/:projectId/:tab?` — one project, a tab at a time. */
export function ProjectScreen(): ReactElement {
  const { projectId = '', tab: segment } = useParams<{ projectId: string; tab?: string }>();
  const tab = parseProjectTab(segment);
  const { data: project, error } = useEntity<Project>(K.project(projectId), () =>
    skill.getProject(projectId)
  );
  const chats = useMobileChats();
  const label = useProjectLabel(projectId, project?.name ?? '');

  if (tab === null) return <Navigate to={projectPath(projectId)} replace />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        back="/m"
        backLabel="Back to chat"
        title={
          project === undefined ? (error === undefined ? 'Project' : 'Project not found') : label
        }
        context={project?.name ?? null}
        trailing={<ProjectMute projectId={projectId} />}
      />
      <nav
        aria-label="Project"
        className="flex shrink-0 overflow-x-auto border-b border-border [scrollbar-width:none]"
      >
        {PROJECT_TABS.map(t => (
          <Link
            key={t.key}
            to={projectPath(projectId, t.key)}
            replace
            aria-current={t.key === tab ? 'page' : undefined}
            className="mobile-tap flex shrink-0 items-center px-3.5 text-body text-text-secondary aria-[current=page]:text-text-primary aria-[current=page]:shadow-[inset_0_-2px_0_var(--accent)]"
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
        {error !== undefined ? (
          <p className="mobile-note text-error">Couldn&apos;t load this project: {error.message}</p>
        ) : (
          <TabBody tab={tab} projectId={projectId} projectName={label} chats={chats} />
        )}
      </div>
    </div>
  );
}

function TabBody({
  tab,
  projectId,
  projectName,
  chats,
}: {
  tab: ProjectTab;
  projectId: string;
  projectName: string;
  chats: MobileChats;
}): ReactElement {
  switch (tab) {
    case 'overview':
      return <OverviewTab projectId={projectId} projectName={projectName} chats={chats} />;
    case 'runs':
      return <RunsTab projectId={projectId} />;
    case 'chats':
      return <ChatsTab projectId={projectId} chats={chats} />;
    case 'issues':
      return <IssuesTab projectId={projectId} />;
    case 'files':
      return <FilesTab projectId={projectId} />;
  }
}
