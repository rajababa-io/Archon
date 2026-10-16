import { afterEach, describe, expect, test } from 'bun:test';
import {
  groupChatsByFolder,
  openFoldersKey,
  readOpenFolders,
  writeOpenFolders,
} from './chat-folders';

// Bun has no DOM; the store as much of it as the module touches.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string): string | null => store.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    store.set(k, v);
  },
  clear: (): void => {
    store.clear();
  },
};

const chat = (id: string, folder: string | null = null) => ({ id, folder });
const ids = (rows: { id: string }[]) => rows.map(r => r.id);

describe('groupChatsByFolder', () => {
  test('keeps chats in no folder apart, in the order given', () => {
    const { loose, folders } = groupChatsByFolder([chat('a'), chat('b', 'Van'), chat('c')]);
    expect(ids(loose)).toEqual(['a', 'c']);
    expect(folders.map(f => f.name)).toEqual(['Van']);
  });

  test('a folder holds its chats in the order given, and folders sort by name', () => {
    const { folders } = groupChatsByFolder([
      chat('a', 'van'),
      chat('b', 'Someday'),
      chat('c', 'van'),
      chat('d', 'Archive'),
    ]);
    expect(folders.map(f => f.name)).toEqual(['Archive', 'Someday', 'van']);
    expect(ids(folders[2]?.chats ?? [])).toEqual(['a', 'c']);
  });

  test('no folders when no chat carries one', () => {
    expect(groupChatsByFolder([chat('a')]).folders).toEqual([]);
  });
});

describe('open folders', () => {
  afterEach(() => {
    localStorage.clear();
  });

  test('round-trips per project', () => {
    writeOpenFolders('p1', new Set(['Van']));
    expect([...readOpenFolders('p1')]).toEqual(['Van']);
    expect(readOpenFolders('p2').size).toBe(0);
  });

  test('an unreadable value reads as every folder closed', () => {
    localStorage.setItem(openFoldersKey('p1'), '{not json');
    expect(readOpenFolders('p1').size).toBe(0);
    localStorage.setItem(openFoldersKey('p1'), JSON.stringify(['Van', 3]));
    expect([...readOpenFolders('p1')]).toEqual(['Van']);
  });
});
