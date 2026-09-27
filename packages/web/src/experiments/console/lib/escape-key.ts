/**
 * What Escape does in the chat box.
 *
 * Stop while the agent works, the way Claude Code and Codex interrupt a turn;
 * otherwise leave the box, as it always has. A stop already in flight swallows
 * the key rather than falling back to leaving the box — the press was meant as
 * a stop, and one stop request is enough.
 *
 * Only reached when nothing inside the composer (the slash menu) claimed the
 * key first.
 */
export type EscapeAction = 'stop' | 'ignore' | 'blur';

export function escapeAction(state: {
  working: boolean;
  canStop: boolean;
  stopping: boolean;
}): EscapeAction {
  if (!state.working || !state.canStop) return 'blur';
  return state.stopping ? 'ignore' : 'stop';
}
