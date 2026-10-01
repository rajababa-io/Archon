import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';

const log = createLogger('orchestrator.mark_ready_to_close');

export interface ReadyToCloseContext {
  /** The conversation this claim is about. Never another one. */
  conversationId: string;
  /** Write the claim, or withdraw it. */
  mark: (ready: boolean) => Promise<void>;
}

const INPUT_SCHEMA = defineNativeToolInputSchema({
  properties: {
    withdraw: {
      kind: 'boolean',
      description:
        'Pass true to take the claim back — you said the work had landed and then found it had not.',
    },
  },
  required: [],
});

/**
 * Lets a chat say its own unit of work has LANDED, so the rail can show
 * "Ready to close" instead of "nothing is pending".
 *
 * This is the caller the `ready` state was missing. Everything else was
 * already built — the status and its ranking, the label, the rail colour, the
 * `ready_at` column, the PATCH route, and the act that CLEARS the mark (a
 * human marking the chat done). Nothing set it, so
 * every finished chat landed on `idle`, which is the exact thing `ready` was
 * added to stop saying. See the console's `primitives/chat-status.ts`.
 *
 * It is deliberately only half of a decision. `done` is the human's judgement
 * and an agent has no tool for it; this is the agent ASKING for that judgement.
 * An agent that could write `done` would be closing its own work, and
 * afterwards nothing could tell a finished chat from a chat that had declared
 * itself finished.
 *
 * WHAT LANDED HAS TO MEAN, because the loose reading is the obvious one and it
 * is wrong: for work whose output is code, landed is MERGED into its base
 * branch with that branch's checks green. An open pull request — green,
 * reviewed, whatever — is unfinished work, not a decision waiting on a human.
 * The only thing left when this is set should be whether the work was the RIGHT
 * work. Deploying is NOT part of it: that is the end of the work item, a
 * separate process, and a chat held open until a deploy reads as unfinished for
 * as long as the deploy waits (#343).
 *
 * Nothing here can verify that, and pretending otherwise would be theatre — a
 * required "evidence" field written to a column that does not exist buys
 * nothing. What makes the mark safe to turn on is that it turns OFF: a human
 * closing the chat spends it, and this tool's `withdraw` takes it back.
 *
 * WHO DECIDES A MESSAGE REOPENS THE WORK is the agent, not the server. The
 * server once cleared the mark on every human message, as evidence against the
 * claim. It almost never was: the next message on a finished chat is nearly
 * always a question ABOUT the finished work ("deployed?", the answer to a
 * "close this chat?" card), and no agent set the mark again after answering,
 * so no open chat ever read "Ready to close" for long (#237). Whether a message
 * is new work is a reading of its words, which is the agent's job — hence
 * `withdraw`, and the description telling the agent when to use it.
 */
export function buildReadyToCloseTool(ctx: ReadyToCloseContext): NativeTool {
  return {
    name: 'mark_ready_to_close',
    description:
      'Declare that this chat\'s unit of work has LANDED, so it reads as "Ready to close" rather than idle. Landed means merged into the base branch with its checks green — an open pull request, however green, is unfinished work and must NOT be marked. Deploying is not part of it: a step left after merge (a deploy, a host install, a credential) belongs on the work item, not in this chat, and does not hold the mark back. Call it once, when the work is genuinely finished and the only question left is whether it was the right work; then say so in your reply and let the human decide. Do not call it to mean "I have replied" or "I have written the code". The mark survives later messages from the human: a question about the finished work, or answering a question you asked, leaves it standing. Pass `withdraw: true` when a message reopens the work — new changes asked for, or the work turns out not to have landed — or when you find the claim was wrong.',
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      const withdraw = input.withdraw === true;
      try {
        await ctx.mark(!withdraw);
        log.info({ conversationId: ctx.conversationId, withdraw }, 'ready_to_close.marked');
        return withdraw
          ? 'mark_ready_to_close: claim withdrawn — this chat reads as open again.'
          : 'mark_ready_to_close: this chat now reads "Ready to close". A human decides whether it is done; you cannot.';
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error({ err: e, conversationId: ctx.conversationId }, 'ready_to_close.failed');
        return `mark_ready_to_close error: ${msg}`;
      }
    },
  };
}
