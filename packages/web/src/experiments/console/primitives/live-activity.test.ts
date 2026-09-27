import { describe, expect, test } from 'bun:test';
import { applyActivity, clearActivity, toActivityEvent } from './live-activity';
import type { ActiveChats } from '../skills/activeChats';

const EV = { conversationId: 'web-2', name: 'Edit', input: { file_path: 'rail.css' } };

describe('toActivityEvent', () => {
  test('reads the event the server sends', () => {
    expect(
      toActivityEvent({
        type: 'conversation_activity',
        conversationId: 'web-1',
        name: 'Read',
        input: { file_path: 'web.ts' },
        startedAt: 1,
      })
    ).toEqual({ conversationId: 'web-1', name: 'Read', input: { file_path: 'web.ts' } });
  });

  test('drops non-string input fields rather than rendering them', () => {
    const ev = toActivityEvent({
      conversationId: 'web-1',
      name: 'Bash',
      input: { n: 3, cmd: 'ls' },
    });
    expect(ev?.input).toEqual({ cmd: 'ls' });
  });

  test('a missing id or name is not an event', () => {
    expect(toActivityEvent({ name: 'Read' })).toBeNull();
    expect(toActivityEvent({ conversationId: 'web-1' })).toBeNull();
    expect(toActivityEvent({ conversationId: '', name: 'Read' })).toBeNull();
    expect(toActivityEvent(null)).toBeNull();
    expect(toActivityEvent('conversation_activity')).toBeNull();
  });
});

describe('applyActivity', () => {
  const prev: ActiveChats = {
    ids: ['web-1'],
    tools: { 'web-1': { name: 'Read', input: {} } },
    ciWaiting: ['web-3'],
    ciWaitingSince: {},
  };

  test('names what a chat is doing without disturbing the others', () => {
    const next = applyActivity(prev, EV);
    expect(next?.tools['web-2']).toEqual({ name: 'Edit', input: { file_path: 'rail.css' } });
    expect(next?.tools['web-1']).toEqual({ name: 'Read', input: {} });
  });

  test('a tool call is proof the chat is working, so the id joins the set', () => {
    expect(applyActivity(prev, EV)?.ids).toEqual(['web-1', 'web-2']);
  });

  test('an id already known is not added twice', () => {
    const next = applyActivity(prev, { ...EV, conversationId: 'web-1' });
    expect(next?.ids).toEqual(['web-1']);
  });

  test('keeps the rest of the snapshot — an event only knows about tools', () => {
    // Rebuilding the object from `ids` and `tools` dropped every other field,
    // so a chat waiting on CI read as idle until the next poll.
    expect(applyActivity(prev, EV)?.ciWaiting).toEqual(['web-3']);
  });

  test('an absent set stays absent — an event must not claim to be a snapshot', () => {
    // `known: false` is what stops the rail calling a mid-turn chat idle. A set
    // built from one event would answer for every chat it has never heard of.
    expect(applyActivity(undefined, EV)).toBeUndefined();
  });
});

describe('clearActivity', () => {
  const prev: ActiveChats = {
    ids: ['web-1', 'web-2'],
    tools: { 'web-1': { name: 'Read', input: {} }, 'web-2': { name: 'Edit', input: {} } },
    ciWaiting: ['web-3'],
    ciWaitingSince: {},
  };

  test('forgets the tool', () => {
    const next = clearActivity(prev, 'web-1');
    expect(next?.tools['web-1']).toBeUndefined();
    expect(next?.tools['web-2']).toEqual({ name: 'Edit', input: {} });
  });

  test('leaves the id alone — a background run holds no conversation lock', () => {
    expect(clearActivity(prev, 'web-1')?.ids).toEqual(['web-1', 'web-2']);
  });

  test('keeps the rest of the snapshot', () => {
    expect(clearActivity(prev, 'web-1')?.ciWaiting).toEqual(['web-3']);
  });

  test('nothing to forget is the same object, not a new one', () => {
    expect(clearActivity(prev, 'web-9')).toBe(prev);
    expect(clearActivity(undefined, 'web-1')).toBeUndefined();
  });
});
