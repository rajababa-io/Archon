import { describe, expect, test } from 'bun:test';
import { awaitsAnswer, awaitsApproval } from './awaiting';

describe('awaitsAnswer', () => {
  const ask = (body: string): string => ['```ask', body, '```'].join('\n');
  const spec = '{"questions":[{"title":"Ship it?","options":[{"label":"Yes"}]}]}';

  test('a chat whose last message is a question is your move', () => {
    expect(
      awaitsAnswer({ completed: false, newestAgentMessage: `Here is the call:\n${ask(spec)}` })
    ).toBe(true);
  });

  test('no agent message last, nothing to decide', () => {
    expect(awaitsAnswer({ completed: false, newestAgentMessage: null })).toBe(false);
    expect(awaitsAnswer({ completed: false, newestAgentMessage: '' })).toBe(false);
  });

  test('prose with no ask block is not a question', () => {
    expect(awaitsAnswer({ completed: false, newestAgentMessage: 'Done. Merged #12.' })).toBe(false);
  });

  test('a question that failed to render is still a question', () => {
    // The agent stopped to ask either way, and a chat whose card is broken is
    // the one most in need of a human opening it. Dropping it would hide the
    // breakage a second time.
    expect(awaitsAnswer({ completed: false, newestAgentMessage: ask('{ not json') })).toBe(true);
  });

  test('the parser decides, not the fence — an unterminated block is prose', () => {
    // Half a block is still streaming in, and is not a question yet.
    expect(awaitsAnswer({ completed: false, newestAgentMessage: '```ask\n{ not json' })).toBe(
      false
    );
  });

  test('an ask block shown as an EXAMPLE inside a longer fence is not a question', () => {
    const quoted = ['````markdown', ask(spec), '````'].join('\n');
    expect(awaitsAnswer({ completed: false, newestAgentMessage: quoted })).toBe(false);
  });

  test('a chat marked done is not asking, even when it ended on a question', () => {
    // The Open tab hides done chats, so counting one put the project header on
    // "Needs you" with no amber chat anywhere to explain it (#197).
    expect(awaitsAnswer({ completed: true, newestAgentMessage: ask(spec) })).toBe(false);
  });
});

describe('awaitsApproval', () => {
  test('paused is not enough — something has to be being asked', () => {
    expect(awaitsApproval({ status: 'paused' })).toBe(false);
    expect(awaitsApproval({ status: 'paused', approval: null })).toBe(false);
    expect(awaitsApproval({ status: 'paused', approval: { message: 'ok?' } })).toBe(true);
  });

  test('a run that is not paused never counts, approval or not', () => {
    for (const status of ['running', 'completed', 'failed', 'cancelled']) {
      expect(awaitsApproval({ status, approval: { message: 'x' } })).toBe(false);
    }
  });
});
