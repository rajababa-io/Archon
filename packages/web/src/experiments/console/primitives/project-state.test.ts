import { describe, expect, test } from 'bun:test';
import { projectState } from './project-state';

const base = { running: 0, awaiting: 0, workingChats: 0, openIssues: 0, chats: 0 };

describe('projectState', () => {
  test('nothing happening → idle', () => {
    expect(projectState(base).status).toBe('idle');
  });

  test('a chat mid-turn is the project working — runs are not the only work', () => {
    expect(projectState({ ...base, workingChats: 1 }).status).toBe('working');
  });

  test("a run executing with no chat mid-turn → running, the rail's word for it", () => {
    expect(projectState({ ...base, running: 1 }).status).toBe('running');
  });

  test('a chat mid-turn outranks a run carrying on without one', () => {
    expect(projectState({ ...base, running: 1, workingChats: 1 }).status).toBe('working');
  });

  test('awaiting outranks working — the half that needs a human wins', () => {
    expect(projectState({ ...base, running: 2, workingChats: 1, awaiting: 1 }).status).toBe(
      'awaiting'
    );
  });

  test('open issues are not a state — nothing is happening, so idle', () => {
    expect(projectState({ ...base, openIssues: 9 }).status).toBe('idle');
  });

  test('a failed run is history, not a state', () => {
    // The chip used to say "At risk" here for days. There is no second word
    // any more: the Runs tab owns the failure.
    expect(projectState({ ...base, chats: 2 }).status).toBe('idle');
  });

  test('why carries the arithmetic, needs-you first', () => {
    const s = projectState({ running: 2, awaiting: 1, workingChats: 1, openIssues: 3, chats: 4 });
    expect(s.why).toBe(
      '1 thing waiting on you · 1 chat working · 2 runs executing · 3 open issues · 4 chats'
    );
  });

  test('why never renders empty', () => {
    expect(projectState(base).why).toBe('nothing open, nothing running');
  });
});
