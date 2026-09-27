import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

/** Chat slash commands plus the project's workflows — feeds the composer's `/` menu. */
export type SlashCommandListing = components['schemas']['SlashCommandListResponse'];

export function listSlashCommands(projectId?: string): Promise<SlashCommandListing> {
  const qs = projectId !== undefined ? `?codebaseId=${encodeURIComponent(projectId)}` : '';
  return requestJson<SlashCommandListing>(`/api/slash-commands${qs}`);
}
