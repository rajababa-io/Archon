import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MidTurnInbox } from '../types';

/**
 * A Claude turn whose input stays open while the CLI can still act.
 *
 * With a string prompt the SDK closes the CLI's input at the first result. That
 * input is also the only channel an in-process tool's answer travels back on,
 * and the CLI outlives that first result whenever the agent left background
 * work running — a background shell or a `Monitor` wakes it for a turn of its
 * own. A tool called in one of those turns has no way to hear back, and the CLI
 * reports it "interrupted before a result was received" without our handler
 * ever running (#222). So the input stays open until the CLI is idle with no
 * background work left — its own statement that no further turn can start —
 * and only then ends, letting the CLI exit.
 *
 * Messages sent into the turn are a separate, shorter window. A user message
 * written to the open input is folded into the running turn at the CLI's next
 * tool boundary, and the first assistant message after the fold carries that
 * message's uuid as `user_message_uuid` — the proof that the agent read it, and
 * the point in the reply where it did. That window closes at the first result:
 * after it the turn the user wrote to is over, and a message is left with its
 * sender to start a turn of its own.
 */
export interface MidTurnPrompt {
  /** The prompt to hand `query()`: the turn's own message, then whatever arrives. */
  input: AsyncIterable<SDKUserMessage>;
  /** Feed every SDK event through here; it reports landings and decides when the input ends. */
  observe: (event: unknown) => void;
  /** End the input. Idempotent; call when the attempt is over for any reason. */
  end: () => void;
}

/**
 * The CLI states its turn-over and background-work levels only when this is
 * set; without them the input could only end at the first result.
 */
export const SESSION_STATE_EVENTS_ENV = { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' } as const;

function userMessage(text: string, uuid?: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    ...(uuid === undefined ? {} : { uuid: uuid as SDKUserMessage['uuid'] }),
  };
}

/** A promise with its resolver, settled once. */
function latch(): { promise: Promise<null>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<null>(resolve => {
    open = (): void => {
      resolve(null);
    };
  });
  return { promise, open };
}

/**
 * @param inbox Where messages sent into the turn come from. Absent, the input
 *   carries only the prompt and exists to keep in-process tools answerable.
 */
export function createMidTurnPrompt(prompt: string, inbox?: MidTurnInbox): MidTurnPrompt {
  const windowClosed = latch();
  const inputEnded = latch();
  let accepting = true;
  let ended = false;
  const closeWindow = (): void => {
    accepting = false;
    windowClosed.open();
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    closeWindow();
    inputEnded.open();
  };

  // SDK uuid → caller id, for messages written and not yet proven read.
  const written = new Map<string, string>();
  let resultSeen = false;
  let statesSeen = false;
  // Non-ambient background tasks the CLI last reported live. Ambient ones are
  // not work the agent waits on, so holding the input open for one would wait
  // on nothing.
  let liveTasks = 0;

  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(prompt);
    while (inbox !== undefined && accepting) {
      // A message the inbox hands over after the window closed is dropped here
      // unwritten. That is safe by the inbox contract: unlanded means
      // undelivered, and the caller still holds it.
      const next = await Promise.race([inbox.next(), windowClosed.promise]);
      if (next === null || !accepting) break;
      const uuid = randomUUID();
      written.set(uuid, next.id);
      yield userMessage(next.text, uuid);
    }
    await inputEnded.promise;
  }

  const observe = (event: unknown): void => {
    const e = event as {
      type?: string;
      subtype?: string;
      state?: string;
      user_message_uuid?: string;
      tasks?: { ambient?: boolean }[];
    };
    if (e.type === 'assistant' && e.user_message_uuid !== undefined) {
      const id = written.get(e.user_message_uuid);
      if (id !== undefined) {
        written.delete(e.user_message_uuid);
        inbox?.landed(id);
      }
    } else if (e.type === 'system' && e.subtype === 'background_tasks_changed') {
      liveTasks = (e.tasks ?? []).filter(t => t.ambient !== true).length;
    } else if (e.type === 'system' && e.subtype === 'session_state_changed') {
      statesSeen = true;
      // Idle is the CLI's turn-over signal, sent only after the turns that
      // finished background work queued have run. Idle with nothing left
      // running means nothing can start another turn.
      if (e.state === 'idle' && resultSeen && liveTasks === 0) end();
    } else if (e.type === 'result') {
      resultSeen = true;
      closeWindow();
      // A CLI that states no session state cannot say when it is done, so this
      // result is the last safe moment to end: past it, the CLI would wait for
      // input that never comes.
      if (!statesSeen) end();
    }
  };

  return { input: input(), observe, end };
}

/** Pass every event through `observe` on its way to the consumer. */
export async function* tapEvents<T>(
  events: AsyncIterable<T>,
  observe: (event: T) => void
): AsyncGenerator<T> {
  for await (const event of events) {
    observe(event);
    yield event;
  }
}
