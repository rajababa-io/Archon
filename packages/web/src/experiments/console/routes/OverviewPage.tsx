import { useMemo, type ReactElement, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { NeedsYouPill } from '../components/NeedsYouPill';
import { PicturesBand } from '../components/PicturesBand';
import { ProjectBriefCard } from '../components/ProjectBriefCard';
import { CodeMap } from '../components/code-map/CodeMap';
import { DeployGap } from '../components/DeployGap';
import { codeMapEmptyText, useCodeMap } from '../components/code-map/useCodeMap';
import type { Run } from '../primitives/run';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { useNow } from '../lib/clock';

function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section aria-label={label} className="flex flex-col gap-x-2 gap-y-1.25">
      <div className="flex items-center gap-2">
        <h2 className="text-mini font-medium text-text-tertiary">{label}</h2>
        {action !== undefined && action !== null ? <span className="ml-auto">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Where a project is, in four bands (#348): the standing answer, the live
 * code map, the pictures, the artifacts.
 *
 * What it does NOT show is as deliberate. The runs and issues lists live on
 * their own tabs; repeating them here made the Overview a second, worse copy
 * of two tabs. The one thing no tab shows is where each change is right now —
 * being coded, in CI, failed, merged, live — and that is the map.
 *
 * "Needs you" is a count, not a list: a run paused on an approval or an input
 * request is the only thing here a human has to clear, and it is listed where
 * it is cleared.
 */
export function OverviewPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();

  const { data: feed } = useEntity<{ runs: Run[] }>(K.runs(projectId), () =>
    skill.listRuns({ codebaseId: projectId, limit: skill.RUN_LIMIT })
  );
  const needsYou = useMemo(
    () => (feed?.runs ?? []).filter(r => r.status === 'paused').length,
    [feed?.runs]
  );
  const map = useCodeMap(projectId);
  const now = useNow();

  if (projectId === '') return <EmptyState title="No project." />;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6.25 pb-6.25 pt-3">
      <div className="mx-auto flex max-w-[860px] flex-col gap-x-5.25 gap-y-4.25">
        {/* 1 — what this is. The standing answer, above everything that moves. */}
        <Section label="Where this project is">
          <ProjectBriefCard
            projectId={projectId}
            badge={<NeedsYouPill count={needsYou} to={`/console/p/${projectId}`} />}
          />
        </Section>

        {/* 2 — where every change is right now. */}
        <Section label="Live code map">
          <CodeMap
            base={map.base}
            changes={map.changes}
            environments={map.environments}
            merging={map.merging}
            emptyText={codeMapEmptyText(map)}
            now={now}
            renderEnvironmentAction={() => <DeployGap projectId={projectId} />}
          />
        </Section>

        {/* 3 — the pictures the chats drew (#350). */}
        <PicturesBand projectId={projectId} />

        {/* 4 — the documents the runs wrote (#351). */}
        <Section label="Artifacts">
          <p className="text-body text-text-tertiary">
            Plans, reports and reviews from this project will show here.
          </p>
        </Section>
      </div>
    </div>
  );
}
