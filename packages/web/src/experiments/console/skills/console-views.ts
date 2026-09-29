/**
 * The console tab the signed-in person last picked, kept on the server so it
 * follows them between devices (#251). Both calls answer 401 when the request
 * carries no verified Cloudflare Access pass; callers treat that as "no person"
 * and keep the browser's own copy.
 */
import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

export type ConsoleView = components['schemas']['ConsoleView'];
export type ConsoleViews = components['schemas']['ConsoleViews'];

export async function getConsoleViews(): Promise<ConsoleViews> {
  return requestJson<ConsoleViews>('/api/console/views');
}

export async function saveConsoleView(scopeId: string, view: ConsoleView): Promise<ConsoleViews> {
  return requestJson<ConsoleViews>('/api/console/views', {
    method: 'PUT',
    body: JSON.stringify({ scopeId, view }),
  });
}
