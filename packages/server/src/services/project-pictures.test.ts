/**
 * A project's pictures (#350). The contracts that matter: a picture belongs to
 * the project whose name is its folder and to no other, the grid is handed a
 * thumbnail and never the original, and a picture that cannot be thumbnailed
 * is a placeholder rather than a full-size download.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import sharp from 'sharp';
import { listProjectPictures, projectPictureRoot, type ThumbnailMaker } from './project-pictures';

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map(removeTempTree));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pictures-'));
  roots.push(root);
  return root;
}

/** Writes a file and dates it `minutesAgo` minutes in the past. */
async function put(root: string, path: string, minutesAgo: number, body = 'x'): Promise<void> {
  const full = join(root, ...path.split('/'));
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, body);
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await utimes(full, at, at);
}

const made: string[] = [];
const fakeThumb: ThumbnailMaker = async (source, target) => {
  made.push(source);
  await writeFile(target, 'thumb');
};

describe('listProjectPictures', () => {
  test('lists only the project folder, newest first, skipping other projects and non-pictures', async () => {
    const root = await makeRoot();
    await put(root, 'archon/topic-a/old.png', 30);
    await put(root, 'archon/topic-b/new.jpg', 1);
    await put(root, 'archon/top.svg', 10);
    await put(root, 'archon/topic-a/notes.md', 0);
    await put(root, 'archon/.hidden/secret.png', 0);
    await put(root, 'wix-access/x/not-ours.png', 0);
    await put(root, 'rajababa-io/wix-access/y/theirs.png', 0);

    const listing = await listProjectPictures({
      publicRoot: root,
      projectName: 'archon',
      otherProjectNames: ['rajababa-io/wix-access'],
      limit: 10,
      offset: 0,
      makeThumbnail: fakeThumb,
    });

    expect(listing.pictures.map(p => p.path)).toEqual([
      'topic-b/new.jpg',
      'top.svg',
      'topic-a/old.png',
    ]);
    expect(listing.all).toBe(3);
    expect(listing.pictures[0]?.url).toBe('/files/archon/topic-b/new.jpg');
    expect(listing.pictures[1]?.topic).toBeNull();
    expect(listing.topics.map(t => t.name)).toEqual(['topic-b', 'topic-a']);
  });

  test("an owner/repo project owns its nested folder, and the owner's folder skips it", async () => {
    const root = await makeRoot();
    await put(root, 'rajababa-io/wix-access/t/inner.png', 0);
    await put(root, 'rajababa-io/form/t/outer.png', 0);

    const inner = await listProjectPictures({
      publicRoot: root,
      projectName: 'rajababa-io/wix-access',
      otherProjectNames: ['rajababa-io'],
      limit: 10,
      offset: 0,
      makeThumbnail: fakeThumb,
    });
    expect(inner.pictures.map(p => p.url)).toEqual(['/files/rajababa-io/wix-access/t/inner.png']);

    const outer = await listProjectPictures({
      publicRoot: root,
      projectName: 'rajababa-io',
      otherProjectNames: ['rajababa-io/wix-access'],
      limit: 10,
      offset: 0,
      makeThumbnail: fakeThumb,
    });
    expect(outer.pictures.map(p => p.path)).toEqual(['form/t/outer.png']);
  });

  test('pages and filters by topic; total counts the filter, all counts everything', async () => {
    const root = await makeRoot();
    for (let i = 0; i < 5; i++) await put(root, `p/a/${String(i)}.png`, i);
    await put(root, 'p/b/z.png', 100);

    const page = await listProjectPictures({
      publicRoot: root,
      projectName: 'p',
      otherProjectNames: [],
      topic: 'a',
      limit: 2,
      offset: 2,
      makeThumbnail: fakeThumb,
    });
    expect(page.pictures.map(p => p.name)).toEqual(['2.png', '3.png']);
    expect(page.total).toBe(5);
    expect(page.all).toBe(6);
    expect(page.topics).toEqual([
      expect.objectContaining({ name: 'a', count: 5 }),
      expect.objectContaining({ name: 'b', count: 1 }),
    ]);
  });

  test('a project that has published nothing is an empty listing', async () => {
    const root = await makeRoot();
    const listing = await listProjectPictures({
      publicRoot: root,
      projectName: 'nothing-yet',
      otherProjectNames: [],
      limit: 8,
      offset: 0,
      makeThumbnail: fakeThumb,
    });
    expect(listing).toEqual({ all: 0, total: 0, topics: [], pictures: [] });
  });

  test('thumbnails live under /files/.thumbs, are made once, and remade when the picture changes', async () => {
    const root = await makeRoot();
    await put(root, 'p/t/a.png', 5);
    const args = {
      publicRoot: root,
      projectName: 'p',
      otherProjectNames: [],
      limit: 8,
      offset: 0,
      makeThumbnail: fakeThumb,
    };
    made.length = 0;

    const first = await listProjectPictures(args);
    expect(first.pictures[0]?.thumbUrl).toBe('/files/.thumbs/p/t/a.png.webp');
    expect((await stat(join(root, '.thumbs/p/t/a.png.webp'))).isFile()).toBe(true);
    await listProjectPictures(args);
    expect(made).toHaveLength(1);

    await put(root, 'p/t/a.png', -5);
    await listProjectPictures(args);
    expect(made).toHaveLength(2);
  });

  test('a picture that cannot be thumbnailed has no thumbUrl, never the full-size url', async () => {
    const root = await makeRoot();
    await put(root, 'p/t/broken.png', 0);
    const listing = await listProjectPictures({
      publicRoot: root,
      projectName: 'p',
      otherProjectNames: [],
      limit: 8,
      offset: 0,
      makeThumbnail: async () => {
        throw new Error('cannot read');
      },
    });
    expect(listing.pictures[0]?.thumbUrl).toBeNull();
  });

  test('the default thumbnailer writes a WebP no wider than 480px', async () => {
    const root = await makeRoot();
    const full = join(root, 'p', 't', 'big.png');
    await mkdir(dirname(full), { recursive: true });
    await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: { r: 40, g: 80, b: 160 } },
    })
      .png()
      .toFile(full);

    const listing = await listProjectPictures({
      publicRoot: root,
      projectName: 'p',
      otherProjectNames: [],
      limit: 8,
      offset: 0,
    });
    expect(listing.pictures[0]?.thumbUrl).toBe('/files/.thumbs/p/t/big.png.webp');
    const meta = await sharp(join(root, '.thumbs/p/t/big.png.webp')).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(480);
  });
});

describe('projectPictureRoot', () => {
  test('refuses a name that leaves the public root or names a dot-folder', () => {
    expect(projectPictureRoot('/pub', '../etc')).toBeNull();
    expect(projectPictureRoot('/pub', '.')).toBeNull();
    expect(projectPictureRoot('/pub', '.thumbs')).toBeNull();
    expect(projectPictureRoot('/pub', 'owner/repo')).toBe(resolve('/pub', 'owner', 'repo'));
  });
});
