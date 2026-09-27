import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

/**
 * Chat slash commands, the project's workflows, and the chat provider's own
 * commands — feeds the composer's `/` menu.
 */
export type SlashCommandListing = components['schemas']['SlashCommandListResponse'];

export function listSlashCommands(
  projectId?: string,
  conversationId?: string
): Promise<SlashCommandListing> {
  const params = new URLSearchParams();
  if (projectId !== undefined) params.set('codebaseId', projectId);
  if (conversationId !== undefined) params.set('conversationId', conversationId);
  const qs = params.size > 0 ? `?${params.toString()}` : '';
  return requestJson<SlashCommandListing>(`/api/slash-commands${qs}`);
}
