/*
 * The mobile shell's service worker. A TEMPLATE: `vite-plugin.ts` emits it as
 * `/m/sw.js` at build time with the placeholders replaced by this build's
 * shell files, a version derived from them, and the shell's scope. A new
 * build therefore changes the worker's bytes, which is what makes the browser
 * install the new one.
 *
 * Registered with scope `/m/`, so it never sees a desktop console request.
 * It precaches the app shell and shows push notifications. API calls and
 * event streams are never touched, so the data a screen shows is always the
 * server's.
 */
const VERSION = __SHELL_VERSION__;
const SHELL_FILES = __SHELL_FILES__;
const CACHE = `archon-shell-${VERSION}`;
/** Every shell route answers with the same index.html; this is its cache key. */
const SHELL_URL = __SHELL_URL__;
const NOTIFICATION_ICON = __NOTIFICATION_ICON__;
const OPEN_PATH_MESSAGE = __OPEN_PATH_MESSAGE__;

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll([SHELL_URL, ...SHELL_FILES]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key.startsWith('archon-shell-') && key !== CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network first: a reachable server always serves the current build. The
  // cached shell is only for when it cannot be reached, so the app still opens.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(SHELL_URL, { cacheName: CACHE }).then(cached => cached ?? Response.error())
      )
    );
    return;
  }

  // Shell files are content-hashed, so a cached copy is never stale.
  if (SHELL_FILES.includes(url.pathname)) {
    event.respondWith(
      caches.match(request, { cacheName: CACHE }).then(cached => cached ?? fetch(request))
    );
  }
});

/*
 * A push from the server (`packages/server/src/services/push-notifier.ts`):
 * `{ title, body, tag, path }`. The tag is per chat or per run, so a newer
 * notification about the same thing replaces the older one.
 */
self.addEventListener('push', event => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  const title = payload && typeof payload.title === 'string' ? payload.title : 'Archon';
  const options = {
    body: payload && typeof payload.body === 'string' ? payload.body : '',
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    data: { path: payload && typeof payload.path === 'string' ? payload.path : SHELL_URL },
  };
  if (payload && typeof payload.tag === 'string') {
    options.tag = payload.tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

/*
 * A tap: bring an open shell window forward and route it to the notification's
 * page, or open the page when no shell window is open. Only a path inside the
 * shell is followed.
 */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const wanted = event.notification.data && event.notification.data.path;
  const path = typeof wanted === 'string' && wanted.startsWith(SHELL_URL) ? wanted : SHELL_URL;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
      const shell = windows.find(w => new URL(w.url).pathname.startsWith(SHELL_URL));
      if (shell) {
        shell.postMessage({ type: OPEN_PATH_MESSAGE, path });
        return shell.focus();
      }
      return self.clients.openWindow(path);
    })
  );
});
