/**
 * The chats last read on this phone, kept in IndexedDB so they can be read
 * again when Archon cannot be reached.
 *
 * A copy for reading, never a source of truth: the shell shows a saved chat
 * only while the server does not answer, and says it is a saved copy. Nothing
 * here is sent anywhere. Kept only on an install without web auth — see
 * `auth-memory.ts`.
 */
import { useSyncExternalStore } from 'react';
import type { FoundChat } from '../../skills';
import type { Message } from '../../primitives/message';
import { authKnownOff } from './auth-memory';

export interface SavedChat {
  found: FoundChat;
  /** The project's name as the shell showed it, for when the project list cannot be read. */
  projectLabel: string;
  messages: Message[];
  /** When this copy was taken, epoch ms. */
  savedAt: number;
}

/** How many chats are kept: the spec's "last ~10 viewed". */
export const SAVED_CHAT_LIMIT = 10;

/** The saved list after saving `chat`: newest first, one copy per chat, at most `limit`. */
export function withSaved(
  list: readonly SavedChat[],
  chat: SavedChat,
  limit = SAVED_CHAT_LIMIT
): SavedChat[] {
  return [chat, ...list.filter(c => c.found.chat.id !== chat.found.chat.id)].slice(0, limit);
}

const DB_NAME = 'archon-mobile';
const STORE = 'chats';

let db: Promise<IDBDatabase> | null = null;

/** One connection for the page, so writes commit in the order they were made. */
function openDb(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (): void => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = (): void => {
      resolve(req.result);
    };
    req.onerror = (): void => {
      reject(req.error ?? new Error('IndexedDB would not open'));
    };
  });
  return db;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => {
      resolve();
    };
    tx.onerror = tx.onabort = (): void => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
  });
}

async function readAll(): Promise<SavedChat[]> {
  const tx = (await openDb()).transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).getAll();
  await done(tx);
  return (req.result as SavedChat[]).sort((a, b) => b.savedAt - a.savedAt);
}

async function writeList(next: readonly SavedChat[], drop: readonly string[]): Promise<void> {
  const tx = (await openDb()).transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const head = next[0];
  if (head !== undefined) store.put(head, head.found.chat.id);
  for (const id of drop) store.delete(id);
  await done(tx);
}

let saved: readonly SavedChat[] | undefined;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/**
 * Losing the copies costs offline reading and nothing else — the shell is
 * whole without them — so a storage failure (private browsing, a full disk)
 * is logged and the list reads as empty rather than breaking a screen.
 */
function ensureLoaded(): Promise<void> {
  loading ??= readAll()
    .catch((e: unknown) => {
      console.warn('[mobile] saved chats could not be read', e);
      return [];
    })
    .then(list => {
      saved = list;
      emit();
    });
  return loading;
}

/** Keep a copy of a chat just read from the server. */
export function saveChat(chat: SavedChat): void {
  if (!authKnownOff()) return;
  void ensureLoaded().then(() => {
    const before = saved ?? [];
    const next = withSaved(before, chat);
    const kept = new Set(next.map(c => c.found.chat.id));
    const drop = before.map(c => c.found.chat.id).filter(id => !kept.has(id));
    saved = next;
    emit();
    writeList(next, drop).catch((e: unknown) => {
      console.warn('[mobile] a chat could not be saved for offline reading', e);
    });
  });
}

/** Forget every saved chat: the install now signs people in. */
export function clearSavedChats(): void {
  void ensureLoaded()
    .then(async () => {
      if (saved?.length === 0) return;
      saved = [];
      emit();
      const tx = (await openDb()).transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      await done(tx);
    })
    .catch((e: unknown) => {
      console.warn('[mobile] saved chats could not be cleared', e);
    });
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  void ensureLoaded();
  return (): void => {
    listeners.delete(onChange);
  };
}

/** Every saved chat, newest first; undefined until storage has been read. */
export function useSavedChats(): readonly SavedChat[] | undefined {
  return useSyncExternalStore(subscribe, () => saved);
}
