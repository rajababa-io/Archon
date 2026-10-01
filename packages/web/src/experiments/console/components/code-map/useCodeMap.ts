import { useEffect, useMemo, useRef, useState } from 'react';
import * as skill from '../../skills';
import type { CodeMapResponse, DeployAnswer, DeployLogEntry } from '../../skills';
import { invalidate, useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { useProjectDeployRefresh } from '../../hooks/useProjectDeployRefresh';
import {
  deriveChanges,
  deriveEnvironments,
  newlyMerged,
  type CodeMapChange,
  type CodeMapEnvironment,
} from './model';

/**
 * How often an open map re-reads GitHub. CI finishing and a merge are the
 * events it shows, and neither reaches this install as a push, so it asks.
 * One GraphQL call per tick, only while the tab is visible.
 */
const POLL_MS = 15_000;
/** How long a line that just merged keeps its merge animation. */
const MERGE_ANIMATION_MS = 2_400;

export interface CodeMapData {
  changes: CodeMapChange[];
  environments: CodeMapEnvironment[];
  /** The trunk's name. Null until a read names it. */
  base: string | null;
  /** Lines that merged since the previous read, for the animation. */
  merging: ReadonlySet<string>;
  /** Why there is nothing to draw, when the read stopped early. */
  reason: string | null;
  loading: boolean;
}

/**
 * The map's data for one project, kept live: the code-map read and the deploy
 * answer are re-read together, so a merge is seen leaving the open list and
 * joining the waiting list in the same tick rather than vanishing in between.
 */
export function useCodeMap(projectId: string): CodeMapData {
  const { data: map } = useEntity<CodeMapResponse>(K.codeMap(projectId), () =>
    skill.getCodeMap(projectId)
  );
  const { data: deployAnswer } = useEntity<DeployAnswer | null>(K.projectDeploy(projectId), () =>
    skill.getProjectDeploy(projectId)
  );
  const hasDeploy = deployAnswer?.kind === 'set-up';
  // Asked for only once it is known the project has a deploy to log.
  const { data: log } = useEntity<DeployLogEntry[]>(
    hasDeploy ? K.projectDeployLog(projectId) : 'noop:no-deploy-log',
    () => (hasDeploy ? skill.getProjectDeployLog(projectId) : Promise.resolve([]))
  );
  // Re-reads the deploy and its log when the host's deploy phase moves.
  useProjectDeployRefresh(projectId);

  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState !== 'visible') return;
      invalidate(K.codeMap(projectId));
      invalidate(K.projectDeploy(projectId));
    };
    const id = setInterval(tick, POLL_MS);
    return (): void => {
      clearInterval(id);
    };
  }, [projectId]);

  const deploy = deployAnswer?.kind === 'set-up' ? deployAnswer.deploy : null;
  const changes = useMemo(() => deriveChanges(map, deploy), [map, deploy]);
  const environments = useMemo(
    () => deriveEnvironments(deploy, changes, log ?? []),
    [deploy, changes, log]
  );

  const [merging, setMerging] = useState<ReadonlySet<string>>(new Set());
  const previous = useRef<CodeMapChange[] | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = changes;
    if (before === null) return;
    const keys = newlyMerged(before, changes);
    if (keys.length > 0) setMerging(new Set(keys));
  }, [changes]);
  // Its own effect: every poll yields a fresh `changes`, and a timer owned by
  // the effect above would be cleared by the next read before it fired.
  useEffect(() => {
    if (merging.size === 0) return;
    const id = setTimeout(() => {
      setMerging(new Set());
    }, MERGE_ANIMATION_MS);
    return (): void => {
      clearTimeout(id);
    };
  }, [merging]);

  return {
    changes,
    environments,
    base: map?.base ?? deploy?.branch ?? null,
    merging,
    reason: map?.reason ?? null,
    loading: map === undefined,
  };
}

/** What an empty map says: still reading, why it could not read, or that nothing is in flight. */
export function codeMapEmptyText(data: CodeMapData): string {
  if (data.loading) return 'Reading GitHub…';
  if (data.reason !== null) return `Cannot read the changes: ${data.reason}.`;
  return `Nothing in flight on ${data.base ?? 'the trunk'}.`;
}
