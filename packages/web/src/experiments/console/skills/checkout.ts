import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

/** Where a chat's agent edits: branch, live checkout or worktree, dirty. Null fields are unknown. */
export type ConversationCheckout = components['schemas']['ConversationCheckoutResponse'];

/**
 * Read the branch and folder a chat's turns run in, and whether that folder
 * holds uncommitted work. The server reads git on every call — nothing here is
 * cached state on the conversation — so asking again is how the answer stays
 * current after the agent commits or switches branch.
 */
export async function getConversationCheckout(
  conversationPlatformId: string
): Promise<ConversationCheckout> {
  return requestJson<ConversationCheckout>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}/checkout`
  );
}
