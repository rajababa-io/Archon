import { describe, expect, test } from 'bun:test';
import type { MidTurnInbox, MidTurnMessage } from '../types';
import { createMidTurnPrompt } from './mid-turn-input';

/** An inbox the test feeds by hand, recording what the provider reports landed. */
function fakeInbox(): MidTurnInbox & { send: (m: MidTurnMessage) => void; landedIds: string[] } {
  const buffered: MidTurnMessage[] = [];
  let waiting: ((m: MidTurnMessage | null) => void) | undefined;
  const landedIds: string[] = [];
  return {
    landedIds,
    send: m => {
      const w = waiting;
      waiting = undefined;
      if (w) w(m);
      else buffered.push(m);
    },
    next: () => {
      const head = buffered.shift();
      if (head) return Promise.resolve(head);
      return new Promise(resolve => {
        waiting = resolve;
      });
    },
    landed: id => {
      landedIds.push(id);
    },
  };
}

const textOf = (m: { message: { content: unknown } }): unknown => m.message.content;

describe('createMidTurnPrompt', () => {
  test('streams the turn prompt, then each message sent into the turn under its own uuid', async () => {
    const inbox = fakeInbox();
    const prompt = createMidTurnPrompt('run the three steps', inbox);
    const it = prompt.input[Symbol.asyncIterator]();

    const first = await it.next();
    expect(first.done).toBe(false);
    expect(textOf(first.value)).toBe('run the three steps');
    expect(first.value.uuid).toBeUndefined();

    inbox.send({ id: 'q-1', text: 'skip step three' });
    const steered = await it.next();
    expect(textOf(steered.value)).toBe('skip step three');
    expect(typeof steered.value.uuid).toBe('string');
    prompt.end();
  });

  test('reports a message landed only when a reply carries its uuid, once', async () => {
    const inbox = fakeInbox();
    const prompt = createMidTurnPrompt('go', inbox);
    const it = prompt.input[Symbol.asyncIterator]();
    await it.next();
    inbox.send({ id: 'q-1', text: 'also check the tests' });
    const steered = await it.next();
    const uuid = steered.value.uuid as string;

    prompt.observe({ type: 'assistant', user_message_uuid: 'someone-else' });
    prompt.observe({ type: 'user' });
    expect(inbox.landedIds).toEqual([]);

    prompt.observe({ type: 'assistant', user_message_uuid: uuid });
    prompt.observe({ type: 'assistant', user_message_uuid: uuid });
    expect(inbox.landedIds).toEqual(['q-1']);
    prompt.end();
  });

  test('the result ends the input, so the CLI exits instead of waiting for another turn', async () => {
    const inbox = fakeInbox();
    const prompt = createMidTurnPrompt('go', inbox);
    const it = prompt.input[Symbol.asyncIterator]();
    await it.next();
    const pending = it.next();
    prompt.observe({ type: 'result' });
    expect((await pending).done).toBe(true);
  });

  test('a message handed over after the turn ended is never written', async () => {
    const inbox = fakeInbox();
    const prompt = createMidTurnPrompt('go', inbox);
    const it = prompt.input[Symbol.asyncIterator]();
    await it.next();
    prompt.end();
    inbox.send({ id: 'late', text: 'too late' });
    expect((await it.next()).done).toBe(true);
    expect(inbox.landedIds).toEqual([]);
  });
});
