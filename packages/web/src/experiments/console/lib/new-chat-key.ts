/**
 * ⌘⇧O / Ctrl+Shift+O — start a new chat.
 *
 * A modified key rather than a keymap letter: the keymap is off while the
 * composer has focus, which on the chat page is nearly always, and `n` is
 * already "new run". ⌘N is not available — the browser opens a window with it.
 *
 * `key` is compared case-insensitively because Shift makes it `O` on most
 * layouts and `o` on some.
 */
export function isNewChatKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return e.key.toLowerCase() === 'o' && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey;
}

/** The label the button badge and the help overlay both show. */
export const NEW_CHAT_KEY_LABEL = '⌘⇧O';
