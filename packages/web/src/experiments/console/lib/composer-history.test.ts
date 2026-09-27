import { describe, expect, it } from 'bun:test';
import {
  AT_DRAFT,
  caretAtEdge,
  sentHistory,
  stepHistory,
  type HistoryDirection,
  type HistoryWalk,
} from './composer-history';
import type { Message } from '../primitives/message';

function msg(role: Message['role'], content: string): Message {
  return {
    id: `${role}-${content}`,
    role,
    content,
    timestamp: '2026-09-27T00:00:00Z',
    toolCalls: [],
    error: null,
    category: null,
    dispatch: null,
    workflowResult: null,
    files: [],
    usage: null,
  };
}

/** Presses keys in order from a given composer text; returns what each press shows. */
function walk(history: string[], draft: string, keys: HistoryDirection[]): (string | null)[] {
  let state: HistoryWalk = AT_DRAFT;
  let text = draft;
  return keys.map(dir => {
    const step = stepHistory(history, state, dir, text);
    if (step === null) return null;
    state = step.walk;
    text = step.text;
    return text;
  });
}

describe('sentHistory', () => {
  it('keeps only what you sent, oldest first', () => {
    const history = sentHistory([
      msg('user', 'A'),
      msg('assistant', 'reply'),
      msg('user', 'B'),
      msg('system', 'note'),
    ]);
    expect(history).toEqual(['A', 'B']);
  });

  it('collapses an immediate repeat and skips blank messages', () => {
    expect(sentHistory([msg('user', 'A'), msg('user', ' A '), msg('user', '  ')])).toEqual(['A']);
  });
});

describe('stepHistory', () => {
  it('send A, send B: Up shows B then A; Down returns to the empty draft', () => {
    expect(walk(['A', 'B'], '', ['older', 'older', 'newer', 'newer'])).toEqual(['B', 'A', 'B', '']);
  });

  it('returns the draft you had typed, not an empty box', () => {
    expect(walk(['A'], 'half a thought', ['older', 'newer'])).toEqual(['A', 'half a thought']);
  });

  it('stops at both ends so the key falls back to the caret', () => {
    expect(walk(['A'], '', ['newer'])).toEqual([null]);
    expect(walk(['A'], '', ['older', 'older'])).toEqual(['A', null]);
    expect(walk([], '', ['older'])).toEqual([null]);
  });
});

describe('caretAtEdge', () => {
  const text = 'line one\nline two';

  it('Up walks only from the first line', () => {
    expect(caretAtEdge(text, 3, 3, 'older')).toBe(true);
    expect(caretAtEdge(text, 12, 12, 'older')).toBe(false);
  });

  it('Down walks only from the last line', () => {
    expect(caretAtEdge(text, 12, 12, 'newer')).toBe(true);
    expect(caretAtEdge(text, 3, 3, 'newer')).toBe(false);
  });

  it('a selection keeps the key for the textarea', () => {
    expect(caretAtEdge('abc', 0, 2, 'older')).toBe(false);
  });

  it('an empty composer is at both edges', () => {
    expect(caretAtEdge('', 0, 0, 'older')).toBe(true);
    expect(caretAtEdge('', 0, 0, 'newer')).toBe(true);
  });
});
