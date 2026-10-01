/**
 * A project's pictures, newest first, for the Overview's Pictures band and the
 * gallery behind it (#350).
 *
 * WHICH PROJECT A PICTURE BELONGS TO. A picture belongs to project P when it
 * sits under `<public>/<P's name>/` — the project segment of the `/files/`
 * path agents publish to (see `getArchonPublicPath`). Nothing else decides it:
 * not the file name, not the topic folder, not a guess from either. A project
 * whose name has an owner (`rajababa-io/atlas`) owns `<public>/rajababa-io/atlas/`.
 * A folder that is no registered project's name belongs to no project and is
 * shown nowhere — `<public>/wix-access/` is not `rajababa-io/wix-access`.
 * When one project's folder sits inside another's (a project named
 * `rajababa-io` beside `rajababa-io/atlas`), the inner folder is the inner
 * project's and is skipped for the outer one, so no picture appears under two
 * projects.
 *
 * THUMBNAILS. The grid shows a small WebP, never the original: a band of eight
 * full-size PNGs is several megabytes, and a gallery of hundreds is the whole
 * directory. Each is written beside the originals, under `<public>/.thumbs/`,
 * so it is served by the existing `/files/` route and adds no public surface —
 * it is a smaller copy of a file that is already public. A thumbnail is made
 * on the first listing that returns its picture and remade when the picture is
 * newer than it. No project folder can be named `.thumbs`, and the walk skips
 * dot-folders, so a thumbnail is never listed as a picture.
 *
 * WHEN THERE IS NO THUMBNAIL. `sharp` is a native module; it loads in the
 * Docker image but not inside a `bun build --compile` binary. There, and for a
 * file sharp cannot read, `thumbUrl` is null and the console draws a
 * placeholder tile — it does not fall back to the full-size image, which is
 * the cost this exists to avoid. The failure is logged once per process so a
 * gallery of placeholders is explainable.
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('project-pictures');
  return cachedLog;
}

const PICTURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const THUMB_DIR = '.thumbs';
const THUMB_WIDTH = 480;
/** Thumbnails made at once; the rest of a page waits its turn. */
const THUMB_CONCURRENCY = 4;

export interface Picture {
  /** Path under the project's folder, `/`-separated. */
  path: string;
  /** The topic folder it sits in — the first segment — or null at the top. */
  topic: string | null;
  /** File name. */
  name: string;
  /** The full-size file, under `/files/`. */
  url: string;
  /** The thumbnail, under `/files/`; null when one could not be made. */
  thumbUrl: string | null;
  modifiedAt: string;
  bytes: number;
}

export interface PictureTopic {
  name: string;
  count: number;
  latestAt: string;
}

export interface PictureListing {
  /** Every picture the project has. */
  all: number;
  /** Pictures matching the topic filter; what `offset` pages through. */
  total: number;
  /** Topic folders, the one with the newest picture first. */
  topics: PictureTopic[];
  pictures: Picture[];
}

interface Found {
  /** Path under the public root, `/`-separated. */
  publicPath: string;
  path: string;
  topic: string | null;
  name: string;
  mtimeMs: number;
  bytes: number;
}

/**
 * The folder a project's pictures live in, or null when its name cannot be
 * one — a name that resolves outside the public root is not a folder in it.
 */
export function projectPictureRoot(publicRoot: string, projectName: string): string | null {
  const root = resolve(publicRoot, projectName);
  const base = resolve(publicRoot);
  if (root === base || !root.startsWith(base + sep)) return null;
  if (
    relative(base, root)
      .split(sep)
      .some(seg => seg.startsWith('.'))
  )
    return null;
  return root;
}

function toFilesUrl(publicPath: string): string {
  return `/files/${publicPath.split('/').map(encodeURIComponent).join('/')}`;
}

async function walk(dir: string, skip: Set<string>, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A project that has published nothing has no folder; that is an empty
    // gallery, not a failure.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(full)) await walk(full, skip, out);
    } else if (entry.isFile() && PICTURE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

async function findPictures(
  publicRoot: string,
  projectName: string,
  otherProjectNames: readonly string[]
): Promise<Found[]> {
  const root = projectPictureRoot(publicRoot, projectName);
  if (root === null) return [];
  const skip = new Set<string>();
  for (const other of otherProjectNames) {
    const otherRoot = projectPictureRoot(publicRoot, other);
    if (otherRoot?.startsWith(root + sep)) skip.add(otherRoot);
  }
  const files: string[] = [];
  await walk(root, skip, files);
  const base = resolve(publicRoot);
  const found = await Promise.all(
    files.map(async (full): Promise<Found | null> => {
      try {
        const s = await stat(full);
        const path = relative(root, full).split(sep).join('/');
        const segments = path.split('/');
        return {
          publicPath: relative(base, full).split(sep).join('/'),
          path,
          topic: segments.length > 1 ? (segments[0] ?? null) : null,
          name: segments[segments.length - 1] ?? path,
          mtimeMs: s.mtimeMs,
          bytes: s.size,
        };
      } catch (err) {
        // Deleted between the walk and the stat: it is simply gone.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    })
  );
  return found
    .filter((f): f is Found => f !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

function topicsOf(found: readonly Found[]): PictureTopic[] {
  const byName = new Map<string, { count: number; latest: number }>();
  for (const f of found) {
    if (f.topic === null) continue;
    const t = byName.get(f.topic);
    if (t === undefined) byName.set(f.topic, { count: 1, latest: f.mtimeMs });
    else {
      t.count += 1;
      t.latest = Math.max(t.latest, f.mtimeMs);
    }
  }
  return [...byName.entries()]
    .sort((a, b) => b[1].latest - a[1].latest || a[0].localeCompare(b[0]))
    .map(([name, t]) => ({ name, count: t.count, latestAt: new Date(t.latest).toISOString() }));
}

/** Makes a thumbnail file from a picture, or throws. */
export type ThumbnailMaker = (source: string, target: string) => Promise<void>;

type SharpModule = typeof import('sharp');
let sharpLoad: Promise<SharpModule['default'] | null> | undefined;
function loadSharp(): Promise<SharpModule['default'] | null> {
  sharpLoad ??= import('sharp').then(
    m => m.default,
    (err: unknown) => {
      getLog().warn({ err }, 'pictures.thumbnailer_unavailable');
      return null;
    }
  );
  return sharpLoad;
}

const sharpThumbnail: ThumbnailMaker = async (source, target) => {
  const sharp = await loadSharp();
  if (sharp === null) throw new Error('sharp is not available in this build');
  await sharp(source, { animated: false })
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 70 })
    .toFile(target);
};

/** Thumbnails being made right now, so two listings make one, not two. */
const inFlight = new Map<string, Promise<string | null>>();
let warnedFailure = false;

async function ensureThumbnail(
  publicRoot: string,
  found: Found,
  make: ThumbnailMaker
): Promise<string | null> {
  const thumbPublicPath = `${THUMB_DIR}/${found.publicPath}.webp`;
  const target = join(publicRoot, ...thumbPublicPath.split('/'));
  try {
    const t = await stat(target);
    if (t.mtimeMs >= found.mtimeMs) return toFilesUrl(thumbPublicPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const pending = inFlight.get(target);
  if (pending !== undefined) return pending;
  const job = (async (): Promise<string | null> => {
    try {
      await mkdir(dirname(target), { recursive: true });
      await make(join(publicRoot, ...found.publicPath.split('/')), target);
      return toFilesUrl(thumbPublicPath);
    } catch (err) {
      if (!warnedFailure) {
        warnedFailure = true;
        getLog().warn({ err, path: found.publicPath }, 'pictures.thumbnail_failed');
      }
      return null;
    } finally {
      inFlight.delete(target);
    }
  })();
  inFlight.set(target, job);
  return job;
}

async function mapPooled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (t: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function listProjectPictures(opts: {
  publicRoot: string;
  projectName: string;
  /** Every other registered project's name, so a nested project's folder is skipped. */
  otherProjectNames: readonly string[];
  topic?: string;
  limit: number;
  offset: number;
  makeThumbnail?: ThumbnailMaker;
}): Promise<PictureListing> {
  const found = await findPictures(opts.publicRoot, opts.projectName, opts.otherProjectNames);
  const filtered = opts.topic === undefined ? found : found.filter(f => f.topic === opts.topic);
  const page = filtered.slice(opts.offset, opts.offset + opts.limit);
  const make = opts.makeThumbnail ?? sharpThumbnail;
  const pictures = await mapPooled(page, THUMB_CONCURRENCY, async f => ({
    path: f.path,
    topic: f.topic,
    name: f.name,
    url: toFilesUrl(f.publicPath),
    thumbUrl: await ensureThumbnail(opts.publicRoot, f, make),
    modifiedAt: new Date(f.mtimeMs).toISOString(),
    bytes: f.bytes,
  }));
  return { all: found.length, total: filtered.length, topics: topicsOf(found), pictures };
}
