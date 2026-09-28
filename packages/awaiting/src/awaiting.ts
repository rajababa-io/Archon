/**
 * "Awaiting" — a chat that is your move. It has two halves, and they arrive by
 * different routes: a question is a MESSAGE (an unanswered ask block), a gate
 * belongs to a RUN the chat started (paused, with something to approve).
 *
 * The console draws the state and the server pushes a notification when a
 * chat enters it. Both read these functions, so the rail cannot say "Needs
 * you" about a chat the phone was never told about, or the reverse.
 */
import { splitReply } from './ask';

/**
 * Whether a chat is waiting on your answer to a question.
 *
 * `newestAgentMessage` is the content of the chat's newest message when that
 * message is the agent's, and null otherwise. "Unanswered" needs no state of
 * its own: answering an ask block is sending a message, so a reply makes the
 * newest message the human's and the question stops being the last word.
 *
 * `splitReply` decides what an ask block is, so a block quoted as an example
 * inside a longer fence is not a question, and a block still streaming (no
 * closing fence yet) is not one either.
 *
 * A malformed block counts. The agent stopped to ask something either way,
 * and a chat whose question failed to render is the one most in need of a
 * human looking at it.
 *
 * A chat a human has marked done is never asking. Closing it is the answer:
 * the question was settled some other way, or dropped (#197).
 */
export function awaitsAnswer(chat: {
  completed: boolean;
  newestAgentMessage: string | null;
}): boolean {
  if (chat.completed) return false;
  if (chat.newestAgentMessage === null || chat.newestAgentMessage === '') return false;
  return splitReply(chat.newestAgentMessage).some(p => p.kind === 'ask' || p.kind === 'ask-error');
}

/**
 * A run stopped on a human gate: paused, with something to approve.
 *
 * `status === 'paused'` alone is not enough: a run can be paused without
 * anything being asked of you (a durable wait, a gate already decided and
 * waiting to resume), and counting those would make the mark mean "something
 * is not finished" — which is what idle already means.
 */
export function awaitsApproval(run: { status: string; approval?: unknown }): boolean {
  return run.status === 'paused' && run.approval !== null && run.approval !== undefined;
}
