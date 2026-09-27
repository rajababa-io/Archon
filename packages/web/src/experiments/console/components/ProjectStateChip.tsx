import type { ReactElement } from 'react';
import { STATUS_COLOR, STATUS_LABEL } from '../primitives/chat-status';
import { projectState } from '../primitives/project-state';
import { useLiveChats } from '../lib/live-chats';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';

/**
 * Whether a project wants something, in one word.
 *
 * The word is a chat's word, because a project does not work or wait — the
 * chats and runs inside it do. The tooltip carries the arithmetic behind it.
 *
 * NOTHING is rendered when the answer is "no". A mark on every project is not
 * a status, it is decoration: measured across six projects it read Idle on
 * three and Working on three, and the three Idles changed nobody's next move.
 * Silence is what makes `Working` and `Awaiting` worth looking at, and the
 * counts beside each project already say how much is in it.
 *
 * The mark is literally the rail's mark: the same `.chat-status` element, so
 * the shape, the color and the pulse have one definition. Drawn separately it
 * pulsed at 1s against the rail's 1.9s — one meaning, two heartbeats, visibly
 * out of step whenever both were on screen.
 */
export function ProjectStateChip({ projectId }: { projectId: string }): ReactElement | null {
  const { data } = useEntity<skill.ProjectCounts>(K.projectCounts(projectId), () =>
    skill.getProjectCounts(projectId)
  );
  // Read unconditionally — a hook cannot sit behind the early return below.
  const { ids: liveIds } = useLiveChats();
  if (data === undefined) return null;

  const state = projectState({
    running: data.running,
    awaiting: data.awaiting,
    workingChats: data.chatIds.filter(id => liveIds.has(id)).length,
    openIssues: data.issues ?? 0,
    chats: data.chats,
  });

  // Idle is the absence of a reason to look, so it prints nothing.
  if (state.status === 'idle') return null;

  return (
    <span
      title={state.why}
      className="inline-flex shrink-0 items-center gap-[6px] text-small font-medium"
    >
      <span aria-hidden className={`chat-status is-${state.status}`}>
        <i />
      </span>
      <span style={{ color: STATUS_COLOR[state.status] }}>{STATUS_LABEL[state.status]}</span>
    </span>
  );
}
