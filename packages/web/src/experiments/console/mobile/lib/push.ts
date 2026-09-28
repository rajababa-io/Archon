/**
 * Push on this device: whether it can work here, and turning it on and off.
 *
 * The browser owns the subscription; the server keeps a copy so it can send.
 * Turning push on asks for permission, subscribes with the server's VAPID
 * key, and hands the subscription over. Turning it off does both halves in
 * the other order, so the server never pushes to an endpoint the browser has
 * already dropped. When the second half fails the first is undone, and every
 * read of "is push on here" hands the browser's subscription to the server
 * again, so the two cannot stay apart and Settings never says "On" about a
 * device the server has no way to reach.
 */
import * as skill from '../../skills';
import { SHELL_SCOPE } from '../pwa/paths';

/**
 * Why push can or cannot be switched on here.
 *
 *   install-first  iOS delivers web push only to a Home Screen app (16.4+),
 *                  and Safari in a tab has no push API at all
 *   unsupported    this browser has no Push API
 *   denied         notifications were refused for this site; only the
 *                  browser's own settings can undo that
 *   ready          a tap can ask
 */
export type PushAvailability = 'install-first' | 'unsupported' | 'denied' | 'ready';

export interface PushEnvironment {
  ios: boolean;
  standalone: boolean;
  hasPushApi: boolean;
  permission: NotificationPermission | null;
}

export function pushAvailability(env: PushEnvironment): PushAvailability {
  if (env.ios && !env.standalone) return 'install-first';
  if (!env.hasPushApi) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  return 'ready';
}

/**
 * iPhone and iPad, including an iPad that reports itself as a Mac (iPadOS 13+
 * asks for desktop sites): a Mac with a touch screen is an iPad.
 */
export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return userAgent.includes('Macintosh') && maxTouchPoints > 1;
}

export function readPushEnvironment(): PushEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    ios: isIosDevice(nav.userAgent, nav.maxTouchPoints),
    standalone: window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true,
    hasPushApi: 'serviceWorker' in nav && 'PushManager' in window && 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : null,
  };
}

/** A base64url VAPID key as the bytes `pushManager.subscribe` wants. */
export function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (a?.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((byte, i) => byte === b[i]);
}

async function shellRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.getRegistration(SHELL_SCOPE);
  if (registration === undefined) {
    throw new Error('The app is not installed on this device yet. Reload and try again.');
  }
  return registration;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(SHELL_SCOPE);
  return registration === undefined ? null : registration.pushManager.getSubscription();
}

/**
 * Whether push is on for this device. A subscription the browser holds is
 * registered with the server again (it stores by endpoint, so this is
 * idempotent); a server that cannot take it makes this reject rather than
 * answer "on".
 */
export async function pushIsOn(): Promise<boolean> {
  const subscription = await currentSubscription();
  if (subscription === null) return false;
  await skill.savePushSubscription(subscription.toJSON());
  return true;
}

/**
 * Ask, subscribe, and register the subscription with the server. Must run
 * from a tap: iOS refuses a permission prompt that no gesture started.
 */
export async function enablePush(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser settings.'
        : 'Notifications were not allowed.'
    );
  }
  const registration = await shellRegistration();
  const key = applicationServerKey(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made against an older key cannot be pushed to with this one.
  if (subscription !== null && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  try {
    await skill.savePushSubscription(subscription.toJSON());
  } catch (e) {
    await subscription.unsubscribe();
    throw e;
  }
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (subscription === null) return;
  await skill.deletePushSubscription(subscription.endpoint);
  const restore = (): Promise<void> => skill.savePushSubscription(subscription.toJSON());
  let dropped: boolean;
  try {
    dropped = await subscription.unsubscribe();
  } catch (e) {
    await restore();
    throw e;
  }
  if (!dropped) {
    await restore();
    throw new Error('This browser would not turn push off. Try again.');
  }
}

/**
 * The Home Screen icon's badge: the needs-you count, where the platform has a
 * badge (installed PWAs on iOS 16.4+, Chrome on Android and desktop).
 */
export function setAppBadge(count: number): void {
  if (!('setAppBadge' in navigator)) return;
  const done = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  done.catch((e: unknown) => {
    console.warn('[push] app badge update failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  });
}
