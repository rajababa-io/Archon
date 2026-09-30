/**
 * Where to retry an image that failed to load, or null when there is nowhere.
 *
 * Agents link published files (`/files/...`, served by this server's
 * `public-files` route) with the install's public address, but the same
 * server is often reached at another one: the phone app runs at the tailnet
 * address, where the public address sits behind a login the app never passed,
 * so the request is redirected to a login page and the image breaks. The
 * bytes are on this server either way, so a `/files/` path is retried once at
 * the page's own origin.
 *
 * Only `/files/` paths, because that prefix is this server's publishing
 * directory; any other path on a foreign host is not ours to guess at. A URL
 * already on the page's origin is not retried — a second request there would
 * fail the same way.
 */
export function sameOriginFallback(src: string, pageOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(src, pageOrigin);
  } catch {
    return null;
  }
  if (url.origin === pageOrigin) return null;
  if (!url.pathname.startsWith('/files/')) return null;
  return `${pageOrigin}${url.pathname}${url.search}`;
}
