/**
 * The ask card's keyboard, as a pure decision so it can be tested without a DOM.
 *
 * The card owns a highlight — a cursor over its rows, the options followed by
 * the "type your own" row when the question allows one. Arrows and letters only
 * MOVE the highlight; Enter is the one key that commits, so a stray letter can
 * never answer a question on its own.
 */
import { splitReply } from '../primitives/ask';
import type { Message } from '../primitives/message';

/** Keycap letters. Ten options is far past the point the list stops being readable. */
export const KEYS = 'ABCDEFGHIJ';

export type AskKeyAction =
  | { kind: 'none' }
  | { kind: 'move'; row: number }
  /** Enter on an option row. */
  | { kind: 'pick'; row: number }
  /** Enter on the "type your own" row. */
  | { kind: 'own' }
  | { kind: 'page'; delta: -1 | 1 }
  | { kind: 'submit' }
  | { kind: 'leave' };

export interface AskKeyPress {
  key: string;
  /** ⌘ on a Mac, Ctrl elsewhere. */
  mod: boolean;
}

export interface AskCursor {
  /** How many options the current question has. */
  options: number;
  /** Whether the "type your own" row follows them. */
  own: boolean;
  /** The highlighted row. */
  cursor: number;
}

export function askKeyAction(press: AskKeyPress, state: AskCursor): AskKeyAction {
  const rows = state.options + (state.own ? 1 : 0);
  const { key, mod } = press;
  if (key === 'Enter' && mod) return { kind: 'submit' };
  if (mod) return { kind: 'none' };
  switch (key) {
    case 'Escape':
      return { kind: 'leave' };
    case 'ArrowUp':
      return { kind: 'move', row: Math.max(0, state.cursor - 1) };
    case 'ArrowDown':
      return { kind: 'move', row: Math.min(rows - 1, state.cursor + 1) };
    case 'ArrowLeft':
      return { kind: 'page', delta: -1 };
    case 'ArrowRight':
      return { kind: 'page', delta: 1 };
    case 'Enter':
      if (state.cursor < state.options) return { kind: 'pick', row: state.cursor };
      return state.own ? { kind: 'own' } : { kind: 'none' };
  }
  if (key.length !== 1) return { kind: 'none' };
  const slot = KEYS.indexOf(key.toUpperCase());
  return slot === -1 || slot >= rows ? { kind: 'none' } : { kind: 'move', row: slot };
}

/**
 * Where the highlight starts on a question: the answer already given, else the
 * recommendation, else the top — so Enter alone takes the suggestion.
 */
export function startRow(
  options: readonly { label: string; recommended?: boolean }[],
  chosen: readonly string[]
): number {
  const picked = options.findIndex(o => chosen.includes(o.label));
  if (picked !== -1) return picked;
  const custom = chosen.some(c => !options.some(o => o.label === c));
  if (custom) return options.length;
  const recommended = options.findIndex(o => o.recommended === true);
  return recommended === -1 ? 0 : recommended;
}

/**
 * Whether the agent's latest reply is waiting on an ask card: some message
 * after your last one carries an ask block. Answering sends a message, which
 * is what ends the wait — the card's own "sent" state never needs to leave it.
 */
export function askAwaitsAnswer(messages: readonly Pick<Message, 'role' | 'content'>[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined || m.role === 'user') return false;
    if (m.role === 'assistant' && splitReply(m.content).some(p => p.kind === 'ask')) return true;
  }
  return false;
}
