/**
 * What a chat is, in seven states — whose move it is.
 *
 *   working   the server is executing a turn for it right now
 *   awaiting  it is your move — a run it started is paused on a gate, or the
 *             agent asked a question and has not been answered
 *   done      a human said this chat's unit of work has landed
 *   ready     the AGENT says the work has landed, and no human has answered
 *   running   no turn is in flight, but a workflow run the chat started is
 *             executing
 *   waiting   nothing is running, but the chat asked to be woken when CI
 *             finishes (`watch_ci`), and the server is watching for it
 *   idle      none of those
 *
 * Exclusive and ordered: a chat that is both working and awaiting is awaiting,
 * because the half that needs a human outranks the half that does not.
 *
 * The signals are different in kind and that is deliberate. "Working" is the
 * server's own answer — the conversation lock, read from /api/health — so it
 * is true even for a turn this browser did not start. "Awaiting" means a chat
 * has asked for something SPECIFIC: a run paused on a gate, or an unanswered
 * ask block. Both are things a human can act on and then be done with.
 *
 * "Closed" (`done`) is the odd one and is meant to be. The others are claims about this
 * instant, which the server can observe; done is a claim about the WORK,
 * which it cannot. A chat is one unit of work — an issue, or a cluster of
 * them — and whether that work has landed is a judgement. Nothing the server
 * can see distinguishes "the issue is closed" from "no run happens to be
 * executing", and that second thing is exactly what idle already says. So it
 * is recorded, by a person, on the row.
 *
 * `ready` is the other half of that same split, and the reason it is a separate
 * state rather than a flavour of done: `done` is the human's judgement, `ready`
 * is the agent asking for one. Between them sits the thing the rail could not
 * say — nothing is running, and someone should decide — which `idle` reported
 * as "nothing pending". An agent that could write `done` would be closing its
 * own work, and afterwards nothing could tell the two apart.
 *
 * It is a STORED mark, set by an explicit act and cleared by two (a human
 * marking the chat done, or the agent withdrawing it when a message reopens the
 * work), for exactly the reason the next paragraph gives. A human message alone
 * does not clear it: most are questions about the finished work (#237).
 *
 * WHAT "FINISHED" HAS TO MEAN, because the loose reading is the obvious one and
 * it is wrong. For a chat whose output is code, finished is LANDED: merged, and
 * running wherever it runs. An open pull request — green, reviewed, whatever —
 * is unfinished work, not a decision waiting on a human. An agent that sets this
 * on "I wrote it" hands back a state that reads done and is not, which is the
 * same lie `idle` was already telling, wearing a better colour. The only thing
 * left when this is set should be whether the work was the RIGHT work.
 *
 * A chat whose last word was merely the agent's is NOT awaiting, and the rule
 * that said so existed twice and failed the same way both times: every
 * finished chat ends with the agent, so the rail went amber end to end and
 * idle became a state nothing ever reached. A mark that is always on is not a
 * signal.
 *
 * Whether you have READ a chat is not one of these states, and was once (#5).
 * It is a separate fact — a chat can need you and be read, or be idle and
 * unread — so it is a separate mark: the title goes bold (`unreadIds`, and
 * `.rail-row.is-unread` in `rail.css`). As a state it had to share this slot,
 * where it borrowed awaiting's amber and hid whose move it was behind it.
 */
import { awaitsAnswer, awaitsApproval } from '@archon/awaiting';
import { runOwnerChatId } from './run';

export type ChatStatus = 'working' | 'awaiting' | 'done' | 'ready' | 'running' | 'waiting' | 'idle';

export interface ChatStatusSets {
  /** Platform conversation ids the server is executing a turn for. */
  working: ReadonlySet<string>;
  /**
   * Chats asking for something specific: a run paused on an approval, or an
   * unanswered question. Outranks working, because a run that has stopped to
   * ask is not running.
   */
  awaiting: ReadonlySet<string>;
  /**
   * Chats a human has marked finished. Ranked BELOW both live states: green
   * is a claim about the work, and what a chat is doing right now outranks
   * it, so a finished chat that starts moving again says so and returns to
   * green when it stops.
   */
  done: ReadonlySet<string>;
  /**
   * Chats that have moved since the reader last opened them. NOT a status —
   * `chatStatus` never reads it. It rides here so every surface takes it from
   * the same object as the dot beside it; the rail renders it as a bold title.
   */
  unread: ReadonlySet<string>;
  /**
   * Chats where the agent has declared the work finished and no human has
   * answered. Ranked BELOW `done` — a human's judgement settles the question
   * the claim was asking — and ABOVE `waiting` and `idle`, because "someone should decide" is
   * strictly more than "nothing is pending".
   */
  ready: ReadonlySet<string>;
  /**
   * Chats with a workflow run executing, read off the project's runs feed.
   * Ranked directly above idle.
   */
  running: ReadonlySet<string>;
  /**
   * Chats with an open CI watch, read from /api/health beside `working`.
   * Ranked directly below `ready`.
   */
  waiting: ReadonlySet<string>;
}

/**
 * Exclusive and ordered: awaiting, working, ready, waiting, done, running,
 * idle — except that `done` always outranks `ready`.
 *
 * The two live states come first because they are about right now, and right
 * now outranks a claim about the work as a whole. Done sits above idle because
 * "this landed" is strictly more than "nothing is pending".
 *
 * There was once another set — chats whose last word was the agent's — ranked
 * below working so a streaming chat would not go amber mid-sentence. The
 * ranking was right and the STATE was wrong: every finished chat ends with the
 * agent, so every finished chat was amber, and idle became unreachable. Its
 * successor, unread, is built on a read marker that can turn off — and lives
 * outside this ranking entirely, as the bold title (#5).
 *
 * `ready` is over `waiting`, `done` and `idle`: the agent claiming its work
 * landed IS the new thing to look at, and the decision it asks for is the
 * reason to open the chat (#181). Under both live states for the same reason
 * everything else is.
 *
 * `done` still outranks `ready`, which is why `ready` is checked only for a
 * chat that is not done: the two answer the same question and the human's
 * answer settles it — a chat the server has been told is finished must not
 * still be asking.
 *
 * `waiting` sits above done (#209): a chat still in flight on CI is more to
 * know than a claim about finished work. Under `working` because a turn in
 * flight is the chat itself moving, where waiting is the server holding a
 * promise for it; under `ready` because a chat that has claimed its work
 * landed is asking for a decision, which outranks a background wait.
 *
 * `running` takes idle's place: before it existed, a
 * chat whose run was executing for twenty minutes said "Nothing is running in
 * this chat" (#188). A run paused on a gate is not here — `awaiting` has it, and
 * outranks — so only a run that is actually moving lands in this set.
 *
 * Every state that is left says something a person can act on, or something a
 * person has already said.
 */
export function chatStatus(conversationId: string, sets: ChatStatusSets): ChatStatus {
  if (sets.awaiting.has(conversationId)) return 'awaiting';
  if (sets.working.has(conversationId)) return 'working';
  if (sets.ready.has(conversationId) && !sets.done.has(conversationId)) return 'ready';
  if (sets.waiting.has(conversationId)) return 'waiting';
  if (sets.done.has(conversationId)) return 'done';
  if (sets.running.has(conversationId)) return 'running';
  return 'idle';
}

/**
 * Every set `chatStatus` reads, built from the conversation rows plus the three
 * live feeds — the one place they are assembled.
 *
 * `chatStatus` owning the precedence was not enough on its own: the rail, the
 * status bar under the open chat and the tab badge each built these sets by
 * hand, and the status bar's copy forgot that an unanswered ask block is
 * awaiting too. The rail dot said "Needs you" while the bar beneath the
 * question said "Ready to close" (#217). Every surface that shows a chat's
 * status reads the object this returns, so they cannot be fed different
 * inputs.
 *
 * `runAwaiting` is a run paused on a gate; an unanswered question is read off
 * the rows here and merged in, because both mean "your move".
 */
export function chatStatusSets(
  conversations: readonly {
    id: string;
    completed: boolean;
    ready: boolean;
    askCandidate: string | null;
    lastActivityAt: string | null;
    lastReadAt: string | null;
  }[],
  live: {
    working: ReadonlySet<string>;
    runAwaiting: ReadonlySet<string>;
    running: ReadonlySet<string>;
    waiting: ReadonlySet<string>;
  }
): ChatStatusSets {
  const awaiting = askAwaitingIds(conversations);
  for (const id of live.runAwaiting) awaiting.add(id);
  return {
    working: live.working,
    awaiting,
    unread: unreadIds(conversations),
    done: completedIds(conversations),
    ready: readyIds(conversations),
    running: live.running,
    waiting: live.waiting,
  };
}

/**
 * Chats the agent has declared finished, as the set `chatStatus` reads.
 *
 * Nothing is derived here, deliberately. The server clears the flag when a
 * human marks the chat done or the agent withdraws its claim, so both directions are
 * already decided by the time the rail sees a row — which is what stops this
 * becoming the "newest message is the agent's" rule that failed twice.
 */
export function readyIds(conversations: readonly { id: string; ready: boolean }[]): Set<string> {
  const out = new Set<string>();
  for (const c of conversations) if (c.ready) out.add(c.id);
  return out;
}

/** Chats a human has marked finished, as the set `chatStatus` reads. */
export function completedIds(
  conversations: readonly { id: string; completed: boolean }[]
): Set<string> {
  const out = new Set<string>();
  for (const c of conversations) if (c.completed) out.add(c.id);
  return out;
}

/**
 * Chats whose newest message is an unanswered question.
 *
 * An ask block is the agent asking you something in a form you can click, and
 * a chat sitting on one is waiting for a human exactly as a paused gate is.
 * What counts is `awaitsAnswer`'s call — shared with the server, which pushes
 * a notification on the same rule.
 *
 * `askCandidate` is the server's newest agent message, sent only when it holds
 * an ask block.
 */
export function askAwaitingIds(
  conversations: readonly { id: string; askCandidate: string | null; completed: boolean }[]
): Set<string> {
  const out = new Set<string>();
  for (const c of conversations) {
    if (awaitsAnswer({ completed: c.completed, newestAgentMessage: c.askCandidate })) out.add(c.id);
  }
  return out;
}

/**
 * Chats that have moved since the reader last opened them — the bold title.
 *
 * This is the rule that failed twice as "the newest message is the agent's".
 * It failed because it could only ever turn ON: every finished chat ends with
 * the agent, so the rail went amber end to end and `idle` became unreachable.
 * The read marker is the whole difference — `lastReadAt` is written when a
 * human opens the chat, so the mark clears and the state is reachable
 * in both directions.
 *
 * Both timestamps are compared as instants rather than strings. They are ISO-8601
 * from the same server, so lexical order would usually agree — but "usually"
 * is not a property worth resting a signal on, and a differing offset or
 * fractional precision breaks it silently rather than loudly.
 *
 * An unparseable or absent `lastActivityAt` is NOT unread: the chat has no
 * activity to be behind on. An absent `lastReadAt` with real activity IS
 * unread, which is what a chat nobody has opened should say.
 *
 * A closed chat is never unread (#289). Closing is the human's last word on
 * it, and the server now stamps the read marker when it closes; this covers
 * the chats closed before it did, which otherwise sat in every count for good
 * — 46 of a tab badge's 47 when it was measured.
 */
export function unreadIds(
  conversations: readonly {
    id: string;
    completed: boolean;
    lastActivityAt: string | null;
    lastReadAt: string | null;
  }[]
): Set<string> {
  const out = new Set<string>();
  for (const c of conversations) {
    if (c.completed) continue;
    const activity = instant(c.lastActivityAt);
    if (activity === null) continue;
    const read = instant(c.lastReadAt);
    if (read === null || activity > read) out.add(c.id);
  }
  return out;
}

/** An ISO timestamp as a comparable number, or null when there is nothing to compare. */
function instant(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Chats with a run paused on an approval (`awaitsApproval`).
 *
 * Which chat a run belongs to is `runOwnerChatId`'s to decide, and asking it
 * is not optional here. This once read `conversationPlatformId` alone, which
 * the runs FEED never carries for a chat-dispatched run; then the worker id,
 * which names a hidden conversation no rail row carries (#227). Either way the
 * set came back empty for exactly the runs it exists to find.
 */
export function awaitingInputIds(
  runs: readonly {
    status: string;
    approval?: unknown;
    parentPlatformId?: string | null;
    conversationPlatformId?: string | null;
    workerPlatformId?: string | null;
  }[]
): Set<string> {
  const out = new Set<string>();
  for (const r of runs) {
    if (!awaitsApproval(r)) continue;
    const id = runOwnerChatId(r);
    if (id !== null && id !== '') out.add(id);
  }
  return out;
}

/**
 * Chats with a workflow run executing right now.
 *
 * Status alone decides it: `running` is the engine's word for a run that is
 * moving, and a paused run is either `awaiting` (a gate asking you) or waiting
 * on something the chat cannot act on. Which chat owns a run is
 * `runOwnerChatId`'s call, for the reason `awaitingInputIds` gives.
 */
export function runningRunIds(
  runs: readonly {
    status: string;
    parentPlatformId?: string | null;
    conversationPlatformId?: string | null;
    workerPlatformId?: string | null;
  }[]
): Set<string> {
  const out = new Set<string>();
  for (const r of runs) {
    if (r.status !== 'running') continue;
    const id = runOwnerChatId(r);
    if (id !== null && id !== '') out.add(id);
  }
  return out;
}

/**
 * The word for each state — the one place it is spelled.
 *
 * Sentence case because the project chip renders it as a label in a header;
 * the rail's stamp lower-cases it in CSS, which is where a purely
 * presentational choice belongs. Two label maps for one set of states would be
 * two vocabularies again, which is the thing this file exists to prevent.
 */
export const STATUS_LABEL: Readonly<Record<ChatStatus, string>> = {
  working: 'Working',
  awaiting: 'Needs you',
  done: 'Closed',
  ready: 'Ready to close',
  running: 'Run going',
  waiting: 'Waiting on CI',
  idle: 'Idle',
};

/**
 * The token that renders each state — one `--status-*` per state, defined for
 * both modes in theme/tokens.css. The rail dot (`.chat-status.is-*` in
 * `rail.css`) reads the same token, so a dot and the word beside it cannot
 * disagree; `chat-status-css.test.ts` holds the two to it.
 *
 * Every state is its own hue and every dot is filled (#331). Three states were
 * once rings in a filled state's colour, and on an 8px mark the shape was all
 * that told them apart. Red is not a state colour: it means failed. An unread
 * chat is marked by its bold title, never by a colour (#5).
 */
export const STATUS_COLOR: Readonly<Record<ChatStatus, string>> = {
  working: 'var(--status-working)',
  awaiting: 'var(--status-awaiting)',
  done: 'var(--status-done)',
  ready: 'var(--status-ready)',
  running: 'var(--status-running)',
  waiting: 'var(--status-waiting)',
  idle: 'var(--status-idle)',
};

export const STATUS_TITLE: Readonly<Record<ChatStatus, string>> = {
  working: 'The agent is working on this chat right now',
  awaiting: 'This chat is waiting for your answer',
  done: "This chat's work is finished",
  ready: 'The work here has landed. Close this chat, or keep going',
  running: 'A workflow run this chat started is running',
  waiting: 'Waiting for CI to finish. This chat will be told when it does',
  idle: 'Nothing is running in this chat',
};

/**
 * Whether "Mark unread" may be used on a chat; when not, the row greys out.
 *
 * Only an `idle` chat that is not already unread may be marked. Every other
 * status is either already asking for attention (awaiting, ready), already green by a human's
 * hand (done), or still moving (working, running, waiting) — and a chat that
 * is still moving will mark itself when it next says something.
 *
 * The chat you have OPEN may be marked too (#228): the page holds the mark
 * while you stay on it, so you can flag the chat in front of you to come back
 * to.
 *
 * A chat with no activity is refused too: unread is `last_activity_at >
 * last_read_at`, so with nothing on the activity side the mark cannot show.
 */
export function canMarkUnread(status: ChatStatus, unread: boolean, hasActivity: boolean): boolean {
  return status === 'idle' && !unread && hasActivity;
}
