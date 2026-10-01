import { useMemo, type ReactElement, type ReactNode } from 'react';
import * as skill from '../../../skills';
import { useEntity } from '../../../store/cache';
import { K } from '../../../store/keys';
import type { Run } from '../../../primitives/run';
import { useNow } from '../../../lib/clock';
import { NeedsYouPill } from '../../../components/NeedsYouPill';
import { PicturesBand } from '../../../components/PicturesBand';
import { ProjectBriefCard } from '../../../components/ProjectBriefCard';
import { CodeMapList } from '../../../components/code-map/CodeMapList';
import { useCodeMap } from '../../../components/code-map/useCodeMap';
import type { MobileChats } from '../../lib/use-mobile-chats';
import { projectPath } from '../../lib/paths';
import { projectChatRows } from '../../lib/switcher';
import { DeployCard } from './DeployCard';

function Section({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <section aria-label={label} className="flex flex-col gap-1.5">
      <h2 className="px-4 text-mini font-medium text-text-tertiary uppercase">{label}</h2>
      {children}
    </section>
  );
}

/**
 * The desktop Overview's four bands, on a phone (#348): where the project is,
 * the live code map as a list, then pictures and artifacts. The deploy card
 * stays — it is the phone's only deploy control. What needs you is a count:
 * runs paused on you plus the project's chats waiting on an answer, each
 * listed on its own tab.
 */
export function OverviewTab({
  projectId,
  projectName,
  chats,
}: {
  projectId: string;
  projectName: string;
  chats: MobileChats;
}): ReactElement {
  const { data: feed } = useEntity<{ runs: Run[] }>(K.runs(projectId), () =>
    skill.listRuns({ codebaseId: projectId, limit: skill.RUN_LIMIT })
  );
  const pausedRuns = useMemo(
    () => (feed?.runs ?? []).filter(r => r.status === 'paused').length,
    [feed?.runs]
  );
  const awaitingChats = useMemo(
    () =>
      projectChatRows(chats.chats ?? [], chats.statuses, chats.statusSets.unread, projectId).filter(
        r => r.status === 'awaiting'
      ).length,
    [chats.chats, chats.statuses, chats.statusSets.unread, projectId]
  );
  const map = useCodeMap(projectId);
  const now = useNow();

  return (
    <div className="flex flex-col gap-5 py-3">
      <Section label="Where this project is">
        <div className="px-4">
          <ProjectBriefCard
            projectId={projectId}
            badge={
              <NeedsYouPill
                className="min-h-11 px-4"
                count={pausedRuns + awaitingChats}
                to={projectPath(projectId, awaitingChats > 0 ? 'chats' : 'runs')}
              />
            }
          />
        </div>
      </Section>

      <div className="px-4">
        <DeployCard projectId={projectId} projectName={projectName} />
      </div>

      <Section label="Live code map">
        <CodeMapList data={map} now={now} />
      </Section>

      {/* Uppercase heading, like the phone's other sections. */}
      <div className="px-4 [&_h2]:uppercase">
        <PicturesBand projectId={projectId} />
      </div>

      <Section label="Artifacts">
        <p className="px-4 text-body text-text-tertiary">
          Plans, reports and reviews from this project will show here.
        </p>
      </Section>
    </div>
  );
}
