/**
 * Up/Down recall in the chat composer: walks the messages you already sent in
 * this chat, the way a shell or Claude Code walks its prompt history.
 *
 * History is derived from the chat's own transcript rather than recorded
 * separately, so it is per chat by construction, survives a reload, and needs
 * nothing new from the server.
 */
import type { Message } from '../primitives/message';

/** Your sent messages in this chat, oldest first, with immediate repeats collapsed. */
export function sentHistory(messages: readonly Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = m.content.trim();
    if (text.length === 0 || out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out;
}

/**
 * Where the walk stands. `index` counts back from the newest entry; -1 means
 * the composer shows your own draft, which `stash` holds while you browse so
 * walking back down returns it untouched.
 */
export interface HistoryWalk {
  index: number;
  stash: string;
}

export const AT_DRAFT: HistoryWalk = { index: -1, stash: '' };

export type HistoryDirection = 'older' | 'newer';

/**
 * One step of the walk, or null when there is nowhere to go — the caller then
 * leaves the key to the textarea.
 */
export function stepHistory(
  history: readonly string[],
  walk: HistoryWalk,
  direction: HistoryDirection,
  current: string
): { walk: HistoryWalk; text: string } | null {
  const next = direction === 'older' ? walk.index + 1 : walk.index - 1;
  if (next < -1 || next >= history.length) return null;
  const stash = walk.index === -1 ? current : walk.stash;
  if (next === -1) return { walk: { index: -1, stash: '' }, text: stash };
  return { walk: { index: next, stash }, text: history[history.length - 1 - next] };
}

/**
 * Whether an arrow press should walk history rather than move the caret: a
 * collapsed caret on the first line for Up, on the last line for Down. Inside
 * a multi-line message the arrows keep moving between lines.
 */
export function caretAtEdge(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  direction: HistoryDirection
): boolean {
  if (selectionStart !== selectionEnd) return false;
  return direction === 'older'
    ? !value.slice(0, selectionStart).includes('\n')
    : !value.slice(selectionEnd).includes('\n');
}
