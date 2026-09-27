import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MidTurnInbox } from '../types';

/**
 * A Claude turn that can be handed messages while it runs.
 *
 * With a string prompt the SDK closes the CLI's input after the first message,
 * so nothing can reach the turn once it starts. Streaming the prompt instead
 * keeps the input open: a user message written to it mid-turn is folded into
 * the running turn at the CLI's next tool boundary, and the first assistant
 * message after the fold carries that message's uuid as `user_message_uuid` —
 * the proof that the agent read it, and the point in the reply where it did.
 *
 * The input has to END when the turn does. An open input keeps the CLI alive
 * waiting for the next turn, so the stream would never finish; and a message
 * written after the result would start a second turn nobody is reading.
 */
export interface MidTurnPrompt {
  /** The prompt to hand `query()`: the turn's own message, then whatever arrives. */
  input: AsyncIterable<SDKUserMessage>;
  /** Feed every SDK event through here; it reports landings and ends the input on the result. */
  observe: (event: unknown) => void;
  /** End the input. Idempotent; call when the attempt is over for any reason. */
  end: () => void;
}

function userMessage(text: string, uuid?: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    ...(uuid === undefined ? {} : { uuid: uuid as SDKUserMessage['uuid'] }),
  };
}

export function createMidTurnPrompt(prompt: string, inbox: MidTurnInbox): MidTurnPrompt {
  let ended = false;
  let signalEnd: () => void = () => undefined;
  const endPromise = new Promise<null>(resolve => {
    signalEnd = (): void => {
      resolve(null);
    };
  });
  const end = (): void => {
    if (ended) return;
    ended = true;
    signalEnd();
  };
  // SDK uuid → caller id, for messages written and not yet proven read.
  const written = new Map<string, string>();

  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(prompt);
    while (!ended) {
      // A message the inbox hands over after the turn ended is dropped here
      // unwritten. That is safe by the inbox contract: unlanded means
      // undelivered, and the caller still holds it.
      const next = await Promise.race([inbox.next(), endPromise]);
      if (next === null || ended) return;
      const uuid = randomUUID();
      written.set(uuid, next.id);
      yield userMessage(next.text, uuid);
    }
  }

  const observe = (event: unknown): void => {
    const e = event as { type?: string; user_message_uuid?: string };
    if (e.type === 'assistant' && e.user_message_uuid !== undefined) {
      const id = written.get(e.user_message_uuid);
      if (id !== undefined) {
        written.delete(e.user_message_uuid);
        inbox.landed(id);
      }
    } else if (e.type === 'result') {
      end();
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
