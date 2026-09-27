/**
 * Composer drafts in localStorage, so a reload — a deploy swapping the
 * container, a crash — does not lose what you were typing. Text only: a File
 * cannot be stored, so attachments still last only as long as the page.
 *
 * Keyed by the page's per-chat draft key. Sending clears the entry.
 */
const key = (draftKey: string): string => `console:draft:${draftKey}`;

// localStorage throws in private-browsing modes or when disabled by policy.
// A draft that cannot be saved is the same as the old behaviour — it lives in
// the page until a reload — so a failure reads as "nothing stored".
export function loadDraftText(draftKey: string): string {
  try {
    return localStorage.getItem(key(draftKey)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraftText(draftKey: string, text: string): void {
  try {
    if (text.length === 0) localStorage.removeItem(key(draftKey));
    else localStorage.setItem(key(draftKey), text);
  } catch {
    // See loadDraftText: not persisted, still held in the page.
  }
}
