import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

/** What the chat's checkout holds uncommitted — or why there is nothing to show. */
export type ConversationChanges = components['schemas']['ConversationChangesResponse'];
export type ChangedFile = components['schemas']['ChangedFile'];
export type ChangeDiff = components['schemas']['ConversationChangeDiffResponse'];

/**
 * The uncommitted changes in the directory this chat's agent runs in. The
 * server resolves that directory by the orchestrator's own rule; nothing
 * here names a path.
 */
export async function getConversationChanges(
  conversationPlatformId: string
): Promise<ConversationChanges> {
  return requestJson<ConversationChanges>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}/changes`
  );
}

/** One changed file's diff. The server refuses a path git does not list as changed. */
export async function getConversationChangeDiff(
  conversationPlatformId: string,
  path: string
): Promise<ChangeDiff> {
  return requestJson<ChangeDiff>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}/changes/diff?path=${encodeURIComponent(path)}`
  );
}
