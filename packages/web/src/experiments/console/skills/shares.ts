/**
 * Share links (#345): letting one published page or file past the
 * deployment's login, at `/share/<code>/`.
 */
import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

export type Share = components['schemas']['Share'];
export type ShareAccess = components['schemas']['ShareAccess'];

/** The share for a published path, or null when it was never shared. */
export async function getShare(path: string): Promise<Share | null> {
  const res = await requestJson<components['schemas']['ShareLookup']>(
    `/api/shares?path=${encodeURIComponent(path)}`
  );
  return res.share;
}

/** Set a path's access. The first time it is shared, the server issues its code. */
export async function setShare(path: string, access: ShareAccess): Promise<Share> {
  const res = await requestJson<components['schemas']['ShareResult']>('/api/shares', {
    method: 'PUT',
    body: JSON.stringify({ path, access }),
  });
  return res.share;
}

/**
 * The share path for a link, or null when the link is not a published file.
 *
 * Any host: agents write the install's public address, and the same file may
 * be linked from another of this server's addresses. Only the `/files/` prefix
 * is this server's publishing directory, so only it is offered for sharing.
 */
export function publishedPath(href: string): string | null {
  let url: URL;
  try {
    // The base only resolves a site-relative href; the host is never read.
    url = new URL(href, 'http://relative.invalid');
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.pathname.startsWith('/files/') || url.pathname === '/files/') return null;
  return url.pathname;
}
