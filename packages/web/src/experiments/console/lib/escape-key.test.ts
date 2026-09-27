import { describe, expect, test } from 'bun:test';
import { escapeAction } from './escape-key';

describe('escapeAction', () => {
  test('stops a working agent', () => {
    expect(escapeAction({ working: true, canStop: true, stopping: false })).toBe('stop');
  });

  test('sends nothing more while a stop is already in flight', () => {
    expect(escapeAction({ working: true, canStop: true, stopping: true })).toBe('ignore');
  });

  test('leaves the box when the agent is idle, as before', () => {
    expect(escapeAction({ working: false, canStop: true, stopping: false })).toBe('blur');
  });

  test('leaves the box when there is no turn this chat can stop', () => {
    expect(escapeAction({ working: true, canStop: false, stopping: false })).toBe('blur');
  });
});
