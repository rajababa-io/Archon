import { describe, expect, test } from 'bun:test';
import { effortChoices, modelChoices, pickerLabel, sameModel } from './chat-model';
import type { ChatModel } from '../skills';

const unpinned: ChatModel = { provider: 'claude', model: 'opus', effort: null, pin: null };
const pinned: ChatModel = {
  provider: 'claude',
  model: 'haiku',
  effort: 'high',
  pin: { model: 'haiku', effort: 'high' },
};

describe('pickerLabel', () => {
  const none = { model: null, effort: null };

  // Unpinned, the control says what the status line always said: what the
  // last turn ran on, whose window the context figure beside it belongs to.
  test('unpinned shows what the last turn ran on', () => {
    expect(pickerLabel(unpinned, { model: 'claude-opus-4-7-20260101', effort: null })).toBe(
      'opus-4-7'
    );
    expect(pickerLabel(unpinned, { model: 'claude-opus-4-7', effort: 'high' })).toBe(
      'opus-4-7 · effort high'
    );
  });

  test('before any turn, it names what the next turn will ask for', () => {
    expect(pickerLabel(unpinned, none)).toBe('opus');
    expect(pickerLabel(pinned, none)).toBe('haiku · effort high');
  });

  // Between the click and the next reply the line describes the LAST turn, so
  // the new choice is shown beside it rather than instead of it.
  test('a pin the last turn did not use shows both, with an arrow', () => {
    expect(pickerLabel(pinned, { model: 'claude-opus-4-7-20260101', effort: null })).toBe(
      'opus-4-7 → haiku · effort high'
    );
  });

  test('once a turn has run on the pin, the arrow goes away', () => {
    expect(pickerLabel(pinned, { model: 'claude-haiku-4-5-20251001', effort: 'high' })).toBe(
      'haiku-4-5 · effort high'
    );
  });

  test('an effort-only pin still draws the arrow until a turn uses it', () => {
    const effortOnly: ChatModel = {
      ...unpinned,
      effort: 'max',
      pin: { model: null, effort: 'max' },
    };
    expect(pickerLabel(effortOnly, { model: 'claude-opus-4-7', effort: null })).toBe(
      'opus-4-7 → opus · effort max'
    );
  });

  test('no data yet still names the control', () => {
    expect(pickerLabel(undefined, none)).toBe('model');
  });
});

describe('sameModel', () => {
  test('a keyword request matches the concrete id the provider reports', () => {
    expect(sameModel('claude-haiku-4-5-20251001', 'haiku')).toBe(true);
    expect(sameModel('claude-opus-4-7', 'haiku')).toBe(false);
  });
});

describe('choices come from the registry, not from here', () => {
  const providers = [
    {
      id: 'claude',
      suggestedModels: [{ id: 'opus' }, { id: 'haiku' }],
      effortLevels: ['low', 'high'] as NonNullable<ChatModel['effort']>[],
    },
    { id: 'opencode' },
  ];

  test("models are the chat provider's registry suggestions", () => {
    expect(modelChoices(unpinned, providers).map(o => o.value)).toEqual(['opus', 'haiku']);
    expect(modelChoices({ ...unpinned, provider: 'opencode' }, providers)).toEqual([]);
  });

  test("effort rungs are the chat provider's ladder; none when it has no control", () => {
    expect(effortChoices(unpinned, providers)).toEqual(['low', 'high']);
    expect(effortChoices({ ...unpinned, provider: 'opencode' }, providers)).toEqual([]);
  });

  test('nothing is offered before the chat model has loaded', () => {
    expect(modelChoices(undefined, providers)).toEqual([]);
    expect(effortChoices(undefined, providers)).toEqual([]);
  });
});
