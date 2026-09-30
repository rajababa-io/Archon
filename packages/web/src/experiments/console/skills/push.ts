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
export type PushDevice = components['schemas']['PushDevice'];
type PushSubscribeResult = components['schemas']['PushSubscribeResponse'];
type PushDeviceList = components['schemas']['PushDeviceList'];

export async function getPushKey(): Promise<PushKey> {
  return requestJson<PushKey>('/api/push/vapid-key');
}

/**
 * Store this browser's subscription — its `PushSubscription.toJSON()`. The
 * answer is the server's id for it, the same id every time this browser saves.
 */
export async function savePushSubscription(subscription: PushSubscriptionJSON): Promise<string> {
  const result = await requestJson<PushSubscribeResult>('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(subscription),
  });
  return result.id;
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await requestJson('/api/push/subscribe', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint }),
  });
}

/** Every browser registered for push: id, label and dates, never endpoints. */
export async function listPushDevices(): Promise<PushDevice[]> {
  return (await requestJson<PushDeviceList>('/api/push/subscriptions')).devices;
}

/** Forget one registered browser by the server's id for it. */
export async function removePushDevice(id: string): Promise<void> {
  await requestJson(`/api/push/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
