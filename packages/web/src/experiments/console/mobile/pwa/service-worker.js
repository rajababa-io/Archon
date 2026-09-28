/*
 * The mobile shell's service worker. A TEMPLATE: `vite-plugin.ts` emits it as
 * `/m/sw.js` at build time with the placeholders replaced by this build's
 * shell files, a version derived from them, and the shell's scope. A new
 * build therefore changes the worker's bytes, which is what makes the browser
 * install the new one.
 *
 * Registered with scope `/m/`, so it never sees a desktop console request.
 * It precaches the app shell and does nothing else: API calls and event
 * streams are never touched, so the data a screen shows is always the
 * server's.
 */
const VERSION = __SHELL_VERSION__;
const SHELL_FILES = __SHELL_FILES__;
const CACHE = `archon-shell-${VERSION}`;
/** Every shell route answers with the same index.html; this is its cache key. */
const SHELL_URL = __SHELL_URL__;

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
