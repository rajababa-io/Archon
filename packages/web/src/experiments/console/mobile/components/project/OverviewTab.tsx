import { useMemo, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import * as skill from '../../../skills';
import { useEntity } from '../../../store/cache';
import { K } from '../../../store/keys';
import type { Run } from '../../../primitives/run';
import type { MobileChats } from '../../lib/use-mobile-chats';
import { projectPath } from '../../lib/paths';
import { projectChatRows } from '../../lib/switcher';
import { ChatRow } from '../ChatRow';
import { RunRow } from '../RunRow';
import { DeployCard } from './DeployCard';

const RECENT_CHATS = 5;

function Section({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <section aria-label={label} className="flex flex-col gap-1.5">
      <h2 className="px-4 text-mini font-medium text-text-tertiary uppercase">{label}</h2>
      {children}
    </section>
  );
}

/**
 * Where a project is: its deploy, what only you can move, and the chats to
 * pick up. What needs you is the desktop overview's rule — runs paused on
 * you — plus the project's chats that are waiting on an answer.
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
    () => (feed?.runs ?? []).filter(r => r.status === 'paused'),
    [feed?.runs]
  );
  const rows = useMemo(
    () => projectChatRows(chats.chats ?? [], chats.statuses, projectId),
    [chats.chats, chats.statuses, projectId]
  );
  const awaiting = rows.filter(r => r.status === 'awaiting');
  const recent = [...rows]
    .sort((a, b) => (b.chat.lastActivityAt ?? '').localeCompare(a.chat.lastActivityAt ?? ''))
    .slice(0, RECENT_CHATS);

  return (
    <div className="flex flex-col gap-5 py-3">
      <div className="px-4">
        <DeployCard projectId={projectId} projectName={projectName} />
      </div>

      <Section label="Needs you">
        {pausedRuns.length === 0 && awaiting.length === 0 ? (
          <p className="px-4 text-body text-text-secondary">Nothing is waiting on you.</p>
        ) : (
          <>
            {pausedRuns.length > 0 ? (
              <div className="flex flex-col gap-2 px-4">
                {pausedRuns.map(run => (
                  <RunRow key={run.id} run={run} />
                ))}
              </div>
            ) : null}
            {awaiting.length > 0 ? (
              <ul>
                {awaiting.map(({ chat, status }) => (
                  <li key={chat.id}>
                    <ChatRow chat={chat} status={status} />
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </Section>

      <Section label="Recent chats">
        {recent.length === 0 ? (
          <p className="px-4 text-body text-text-tertiary">No open chats.</p>
        ) : (
          <ul>
            {recent.map(({ chat, status }) => (
              <li key={chat.id}>
                <ChatRow chat={chat} status={status} />
              </li>
            ))}
          </ul>
        )}
        <Link
          to={projectPath(projectId, 'chats')}
          className="mobile-row flex items-center gap-1 px-4 text-body text-text-secondary"
        >
          Every chat in this project
          <ChevronRight aria-hidden className="h-4 w-4" />
        </Link>
      </Section>
    </div>
  );
}
