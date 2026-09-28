import { runOwnerChatId, type Run } from '../../primitives/run';
import { elapsedSince, ensureUtc, formatElapsed, relativeTime } from '../../lib/format';

/**
 * Which run each CI wait belongs to, by run id, with when the wait began.
 *
 * A CI watch is held by a chat, not a run: the server reports chats waiting
 * on CI. On a list of runs the wait belongs to the newest run that chat
 * launched — the one whose pull request CI is checking. Older runs from the
 * same chat finished before it and are not what is being waited on.
 */
export function ciWaitByRun(
  runs: readonly Run[],
  ciWaitingSince: Readonly<Record<string, number>>
): Map<string, number> {
  const newest = new Map<string, Run>();
  for (const run of runs) {
    const chat = runOwnerChatId(run);
    if (chat === null || ciWaitingSince[chat] === undefined) continue;
    const held = newest.get(chat);
    if (
      held === undefined ||
      Date.parse(ensureUtc(run.startedAt)) > Date.parse(ensureUtc(held.startedAt))
    ) {
      newest.set(chat, run);
    }
  }
  const out = new Map<string, number>();
  for (const [chat, run] of newest) out.set(run.id, ciWaitingSince[chat]);
  return out;
}

/**
 * The time on a run's row: how long it has been going while it is live, how
 * long CI has been checking its work while that runs, and otherwise when it
 * started.
 */
export function runRowClock(run: Run, ciSince: number | undefined, now: number): string {
  if (ciSince !== undefined) {
    return `CI ${formatElapsed(Math.max(0, Math.floor((now - ciSince) / 1000)))}`;
  }
  if (run.status === 'running' || run.status === 'paused') {
    return formatElapsed(elapsedSince(run.startedAt, new Date(now).toISOString()));
  }
  return relativeTime(run.startedAt, now);
}
