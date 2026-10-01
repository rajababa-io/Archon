/**
 * Share links (#345) — which published paths may be shared, and how a request
 * under `/share/<code>/` resolves to one file.
 *
 * WHAT A SHARE CAN REACH. Only what sits under the public files root, the same
 * directory `/files/` serves behind the deployment's login, and only below the
 * shared path. The share address is the one prefix the operator lets past that
 * login, so everything here is written for a requester who is anonymous:
 * `..` is refused outright, and every resolved file is checked again after
 * symlinks are followed, so a link planted inside a shared folder cannot point
 * out of it.
 */
import { realpath, stat } from 'fs/promises';
import { isAbsolute, join, resolve, sep } from 'path';
import type { Share } from '../db/shares';

export type SharePathResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The share path for whatever an agent or a person called the thing.
 *
 * Accepts the private address in any of its spellings — a full URL, `/files/…`,
 * or the bare relative path — because the caller copies whichever one it has
 * in front of it. The result is relative to the public files root, with no
 * leading or trailing slash.
 */
export function normalizeSharePath(input: string): SharePathResult {
  let raw = input.trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      raw = new URL(raw).pathname;
    } catch {
      return { ok: false, reason: `not a valid URL: ${input}` };
    }
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, reason: `not a valid path: ${input}` };
  }
  let path = decoded.replace(/^\/+/, '');
  if (path.startsWith('files/')) path = path.slice('files/'.length);
  path = path.replace(/\/+$/, '');
  if (path === '')
    return { ok: false, reason: 'the path is empty — name a published file or folder' };
  if (path.includes('\\') || path.includes('\0')) {
    return { ok: false, reason: `not a valid path: ${input}` };
  }
  const segments = path.split('/');
  if (segments.some(s => s === '' || s === '.' || s === '..')) {
    return { ok: false, reason: `the path may not contain empty, "." or ".." segments: ${input}` };
  }
  return { ok: true, path };
}

/** True when `child` is `parent` or lies inside it. Both must already be real paths. */
function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The real path of an existing entry, or null when it does not exist. */
async function real(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/**
 * Whether `path` (already normalized) names a file or folder that exists under
 * the root, and which. Refuses anything whose real location is outside it.
 */
export async function publishedEntry(root: string, path: string): Promise<'file' | 'dir' | null> {
  const realRoot = await real(root);
  if (realRoot === null) return null;
  const target = await real(join(realRoot, path));
  if (target === null || !within(realRoot, target) || target === realRoot) return null;
  const info = await stat(target);
  if (info.isDirectory()) return 'dir';
  return info.isFile() ? 'file' : null;
}

/**
 * The address a share answers at. A folder's ends in `/` so the relative links
 * inside its pages (`img/a.png`, `slides/x.html`) resolve below the code.
 */
export function shareAddress(code: string, kind: 'file' | 'dir'): string {
  return kind === 'dir' ? `/share/${code}/` : `/share/${code}`;
}

/** What sharing a published path actually shares, and where in it the reader lands. */
export interface ShareTarget {
  /** The path the share row holds. */
  path: string;
  kind: 'file' | 'dir';
  /** The page inside a shared folder the address opens at; '' for the folder itself. */
  page: string;
}

/**
 * What sharing `path` (already normalized) means, or null when nothing is
 * published there.
 *
 * A web page is shared as its FOLDER. Agents link a deck or a mockup by its
 * `index.html`, and that page loads its slides, scripts and pictures from
 * beside it; shared alone it would open with every one of them missing. So an
 * `.html` file shares the folder it sits in and the address lands on the page.
 * Every other file is shared alone.
 */
export async function shareTarget(root: string, path: string): Promise<ShareTarget | null> {
  const entry = await publishedEntry(root, path);
  if (entry === null) return null;
  const slash = path.lastIndexOf('/');
  if (entry === 'file' && /\.html?$/i.test(path) && slash > 0) {
    const page = path.slice(slash + 1);
    return { path: path.slice(0, slash), kind: 'dir', page: page === 'index.html' ? '' : page };
  }
  return { path, kind: entry, page: '' };
}

/** The full site-relative address for a share and the target it was asked for. */
export function targetAddress(code: string, target: Pick<ShareTarget, 'kind' | 'page'>): string {
  return shareAddress(code, target.kind) + encodeURIComponent(target.page);
}

export type ShareResolution =
  | { kind: 'file'; file: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'missing' };

/**
 * What a request for `rest` below a share should get.
 *
 * `rest` is the part of the request path after `/share/<code>/`, still
 * percent-encoded. `trailingSlash` is whether the request named the code with
 * a slash after it — a folder asked for without one is redirected, or every
 * relative link in its index page would resolve one level too high.
 *
 * A restricted share is `missing`, the same answer as no share at all, so the
 * address says nothing about whether it once worked.
 */
export async function resolveShareRequest(
  root: string,
  share: Share,
  rest: string,
  trailingSlash: boolean
): Promise<ShareResolution> {
  if (share.access !== 'link') return { kind: 'missing' };
  const realRoot = await real(root);
  if (realRoot === null) return { kind: 'missing' };
  const base = await real(join(realRoot, share.path));
  if (base === null || base === realRoot || !within(realRoot, base)) return { kind: 'missing' };

  const baseInfo = await stat(base);
  if (baseInfo.isFile()) {
    // A shared file has no children.
    return rest === '' ? { kind: 'file', file: base } : { kind: 'missing' };
  }
  if (!baseInfo.isDirectory()) return { kind: 'missing' };
  if (rest === '' && !trailingSlash) {
    return { kind: 'redirect', location: shareAddress(share.code, 'dir') };
  }

  let relative: string;
  try {
    relative = decodeURIComponent(rest);
  } catch {
    return { kind: 'missing' };
  }
  const segments = relative.split('/');
  if (
    segments.some(s => s === '.' || s === '..') ||
    relative.includes('\\') ||
    relative.includes('\0')
  ) {
    return { kind: 'missing' };
  }
  if (isAbsolute(relative)) return { kind: 'missing' };
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';

  const target = await real(resolve(base, relative));
  if (target === null || !within(base, target)) return { kind: 'missing' };
  const info = await stat(target);
  return info.isFile() ? { kind: 'file', file: target } : { kind: 'missing' };
}
