/**
 * Where a project is, in one word.
 *
 * A project does not work, idle or wait — its CHATS and RUNS do. So the word
 * is not a project vocabulary at all: it is borrowed from `chat-status.ts`
 * rather than restated here. One vocabulary means it is learned once, in the
 * rail, and read everywhere.
 *
 * Three of a chat's states roll up — awaiting, working, running; `done` does not, and deliberately.
 * The chip prints NOTHING unless a project wants attention, and a project
 * whose every chat has landed wants none — the green would be a mark on every
 * finished project, which is the decoration this chip exists to refuse. It is
 * also a roll-up nothing can compute yet: the counts endpoint reports chats,
 * runs and open issues, not which chats a human has marked finished.
 *
 * One word, never two. There used to be a second "health" word — `At risk`
 * for one failed run, `Off track` for a streak — and it had to be special-
 * cased out of its own contradiction (`Clear · At risk` said nothing is wrong
 * and something is wrong in one breath). A finished failed run is history, not
 * a state: the Runs tab is where it is read and where it is acted on.
 */

import type { ChatStatus } from './chat-status';

export interface ProjectState {
  status: ChatStatus;
  /** The arithmetic behind the word, for the tooltip. */
  why: string;
}

export interface ProjectStateInput {
  /** Runs executing right now. */
  running: number;
  /**
   * Runs paused on a gate that is actually ASKING something.
   *
   * Not the paused count: a run can be paused with nothing pending, and
   * counting those as your move would make the amber mean "unfinished", which
   * is what idle already says.
   */
  awaiting: number;
  /** Chats the server is executing a turn for — its conversation lock. */
  workingChats: number;
  openIssues: number;
  chats: number;
}

export function projectState({
  running,
  awaiting,
  workingChats,
  openIssues,
  chats,
}: ProjectStateInput): ProjectState {
  // Exclusive and ordered, exactly as a single chat is ordered: the half that
  // needs a human outranks the half that does not, and an agent mid-turn
  // outranks a run carrying on without one.
  const status: ChatStatus =
    awaiting > 0 ? 'awaiting' : workingChats > 0 ? 'working' : running > 0 ? 'running' : 'idle';

  const why =
    [
      awaiting > 0 ? `${String(awaiting)} thing${awaiting === 1 ? '' : 's'} waiting on you` : null,
      workingChats > 0
        ? `${String(workingChats)} chat${workingChats === 1 ? '' : 's'} working`
        : null,
      running > 0 ? `${String(running)} run${running === 1 ? '' : 's'} executing` : null,
      openIssues > 0 ? `${String(openIssues)} open issue${openIssues === 1 ? '' : 's'}` : null,
      chats > 0 ? `${String(chats)} chat${chats === 1 ? '' : 's'}` : null,
    ]
      .filter((s): s is string => s !== null)
      .join(' · ') || 'nothing open, nothing running';

  return { status, why };
}
