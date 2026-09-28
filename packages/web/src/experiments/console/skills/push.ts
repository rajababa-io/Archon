/**
 * Web Push: the server's key, this browser's subscription, what to be told
 * about, and the heartbeat that says which chat is on screen.
 */
import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

export type PushKey = components['schemas']['PushVapidKeyResponse'];
export type PushPrefs = components['schemas']['PushPrefs'];
export type PushPrefsChange = components['schemas']['PushPrefsChange'];
export type PushTestResult = components['schemas']['PushTestResponse'];
export type PushTriggers = components['schemas']['PushTriggers'];

export async function getPushKey(): Promise<PushKey> {
  return requestJson<PushKey>('/api/push/vapid-key');
}

/** Store this browser's subscription — its `PushSubscription.toJSON()`. */
export async function savePushSubscription(subscription: PushSubscriptionJSON): Promise<void> {
  await requestJson('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(subscription),
  });
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await requestJson('/api/push/subscribe', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint }),
  });
}

export async function getPushPrefs(): Promise<PushPrefs> {
  return requestJson<PushPrefs>('/api/push/prefs');
}

/** One change; the answer is the preferences after it. */
export async function changePushPrefs(change: PushPrefsChange): Promise<PushPrefs> {
  return requestJson<PushPrefs>('/api/push/prefs', {
    method: 'PUT',
    body: JSON.stringify(change),
  });
}

export async function sendTestPush(): Promise<PushTestResult> {
  return requestJson<PushTestResult>('/api/push/test', { method: 'POST' });
}

/** The chat this page is showing while visible, or null. */
export async function reportPresence(
  clientId: string,
  conversationId: string | null
): Promise<void> {
  await requestJson('/api/push/presence', {
    method: 'POST',
    body: JSON.stringify({ clientId, conversationId }),
    // A page being hidden or closed must still get its "not looking" out.
    keepalive: true,
  });
}
