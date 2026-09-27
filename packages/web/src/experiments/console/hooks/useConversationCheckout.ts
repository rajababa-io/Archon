import { useEffect } from 'react';
import { usePageVisible } from '../lib/use-page-visible';
import * as skill from '../skills';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';

/**
 * How often an open chat re-reads its checkout while the tab is on screen.
 *
 * The agent commits and switches branch in the middle of a turn, and nothing
 * announces it — git has no event stream here. A turn ending re-reads too, so
 * this only bounds how stale the line can get during a long one.
 */
const POLL_MS = 15_000;

/**
 * The branch, folder and dirty state of a chat's checkout, kept current.
 *
 * `turnKey` should change whenever a turn starts or ends; each change re-reads,
 * because a finished turn is exactly when a commit or a stray file appears.
 * Returns undefined until the first read, and for a chat that does not exist
 * yet — the caller hides the segment rather than showing a guess.
 */
export function useConversationCheckout(
  conversationId: string | null,
  turnKey: string
): skill.ConversationCheckout | undefined {
  const key = conversationId === null ? null : K.conversationCheckout(conversationId);
  const visible = usePageVisible();

  const view = useEntity(key ?? 'checkout:none', () =>
    conversationId === null
      ? Promise.resolve(undefined)
      : skill.getConversationCheckout(conversationId)
  );

  useEffect(() => {
    if (key !== null) invalidate(key);
  }, [key, turnKey]);

  useEffect(() => {
    if (key === null || !visible) return;
    // Coming back to the tab is itself a reason to look again.
    invalidate(key);
    const id = setInterval(() => {
      invalidate(key);
    }, POLL_MS);
    return (): void => {
      clearInterval(id);
    };
  }, [key, visible]);

  return key === null ? undefined : view.data;
}
