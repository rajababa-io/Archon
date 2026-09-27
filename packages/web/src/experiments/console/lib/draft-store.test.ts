import { beforeEach, describe, expect, it } from 'bun:test';
import { loadDraftText, saveDraftText } from './draft-store';

// No DOM here; a Map stands in for the browser's storage.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string): string | null => store.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    store.set(k, v);
  },
  removeItem: (k: string): void => {
    store.delete(k);
  },
};

describe('draft store', () => {
  beforeEach(() => {
    store.clear();
  });

  it('gives back the draft saved for a chat, as after a reload', () => {
    saveDraftText('p1:c1', 'half a thought');
    expect(loadDraftText('p1:c1')).toBe('half a thought');
  });

  it('keeps each chat to its own draft', () => {
    saveDraftText('p1:c1', 'one');
    saveDraftText('p1:c2', 'two');
    expect(loadDraftText('p1:c1')).toBe('one');
    expect(loadDraftText('p1:c2')).toBe('two');
  });

  it('an emptied draft (a send) removes the entry', () => {
    saveDraftText('p1:c1', 'sent soon');
    saveDraftText('p1:c1', '');
    expect(loadDraftText('p1:c1')).toBe('');
    expect(store.size).toBe(0);
  });
});
