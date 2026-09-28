import { useCallback, useEffect, useRef } from 'react';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import { useLiveChats } from '../lib/live-chats';

const POLL_MS = 30_000;

/**
 * Keeps a project's deploy answer current while it is on screen, and returns
 * the re-read to call after an action.
 *
 * Its own poll: the answer reads the branch and the GitHub API, which is too
 * much to ride every health read the stream triggers. The health poll sees a
 * phase change first, so the answer is re-read when it does — the row leaves
 * "Deploying" when the deploy does and not 30s later.
 */
export function useProjectDeployRefresh(projectId: string): () => void {
  const key = K.projectDeploy(projectId);
  const { deploy: healthDeploy } = useLiveChats();

  const reload = useCallback((): void => {
    invalidate(key);
    invalidate(K.projectDeployLog(projectId));
  }, [key, projectId]);

  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === 'visible') invalidate(key);
    };
    const id = setInterval(tick, POLL_MS);
    return (): void => {
      clearInterval(id);
    };
  }, [key]);

  const healthPhase = healthDeploy?.phase;
  const lastPhase = useRef(healthPhase);
  useEffect(() => {
    if (lastPhase.current === healthPhase) return;
    lastPhase.current = healthPhase;
    reload();
  }, [healthPhase, reload]);

  return reload;
}
