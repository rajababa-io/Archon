import { useMemo, type ReactElement } from 'react';
import * as skill from '../../../skills';
import { useEntity } from '../../../store/cache';
import { K } from '../../../store/keys';
import type { Run } from '../../../primitives/run';
import { useLiveChats } from '../../../lib/live-chats';
import { ciWaitByRun } from '../../lib/run-rows';
import { RunRow } from '../RunRow';

/** The project's runs, newest first, each opening its detail. Nothing starts one here. */
export function RunsTab({ projectId }: { projectId: string }): ReactElement {
  const { data: feed, error } = useEntity<{ runs: Run[] }>(K.runs(projectId), () =>
    skill.listRuns({ codebaseId: projectId, limit: skill.RUN_LIMIT })
  );
  const { ciWaitingSince } = useLiveChats();
  const runs = feed?.runs;
  const ciWaits = useMemo(() => ciWaitByRun(runs ?? [], ciWaitingSince), [runs, ciWaitingSince]);

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <p className="text-small text-text-tertiary">Runs start from a chat.</p>
      {error !== undefined ? (
        <p className="text-small text-error">Couldn&apos;t load the runs: {error.message}</p>
      ) : runs === undefined ? (
        <p className="text-small text-text-tertiary">Loading runs…</p>
      ) : runs.length === 0 ? (
        <p className="text-body text-text-secondary">No runs yet.</p>
      ) : (
        runs.map(run => <RunRow key={run.id} run={run} ciSince={ciWaits.get(run.id)} />)
      )}
    </div>
  );
}
