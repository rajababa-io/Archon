/**
 * The suggested next message in the chat box: when it shows, and which keys
 * take it. Pure so the rules can be tested without a DOM.
 *
 * It shows only in an EMPTY box — so it can never collide with the `/` menu,
 * which needs a `/` typed — and only until you type: typing anything dismisses
 * that suggestion, even if you then clear the box again.
 */

/** The suggestion to show, or null. */
export function suggestionToShow(
  suggestion: { text: string } | null,
  draft: string,
  dismissed: string | null
): string | null {
  if (suggestion === null || draft.length > 0 || suggestion.text === dismissed) return null;
  return suggestion.text;
}

/** Tab, or Right arrow (the caret is always at the end of an empty box), with no modifier. */
export function acceptsSuggestion(e: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
  return e.key === 'Tab' || e.key === 'ArrowRight';
}
