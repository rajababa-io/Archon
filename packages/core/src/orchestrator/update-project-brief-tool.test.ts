import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  MAX_BRIEF_PICTURES,
  mergeBrief,
  resolveBriefPictures,
  sameContent,
  isBlank,
  type Brief,
  type BriefPicture,
  type PictureScope,
} from './update-project-brief-tool';

const NOW = 1_700_000_000_000;
const b = (p: Partial<Brief> = {}): Brief => ({
  why: 'w',
  doing: 'd',
  where: 'r',
  pictures: [],
  updatedAt: 1,
  ...p,
});
const pic = (path: string, caption = path): BriefPicture => ({ path, caption });

describe('mergeBrief', () => {
  test('an omitted field keeps its value', () => {
    const out = mergeBrief(b(), { doing: 'new doing' }, NOW);
    expect(out).toEqual({ why: 'w', doing: 'new doing', where: 'r', pictures: [], updatedAt: NOW });
  });

  test('identical text leaves updatedAt alone', () => {
    // The whole point. The card says "written 4m ago", and that is the only
    // thing stopping a stale brief being believed — an agent that rewrites the
    // same words must not be able to make it look fresh.
    const out = mergeBrief(b({ updatedAt: 42 }), { why: 'w', doing: 'd', where: 'r' }, NOW);
    expect(out.updatedAt).toBe(42);
  });

  test('whitespace-only difference is not a change', () => {
    const out = mergeBrief(b({ updatedAt: 42 }), { doing: '  d  ' }, NOW);
    expect(out.updatedAt).toBe(42);
  });

  test('a real change stamps the time', () => {
    expect(mergeBrief(b({ updatedAt: 42 }), { where: 'moved on' }, NOW).updatedAt).toBe(NOW);
  });

  test('a non-string field is ignored rather than coerced', () => {
    // An agent passing a number must not blank the field or write "42".
    const out = mergeBrief(b(), { doing: 42 }, NOW);
    expect(out.doing).toBe('d');
    expect(out.updatedAt).toBe(1);
  });

  test('writing the first brief stamps it', () => {
    const empty: Brief = { why: '', doing: '', where: '', pictures: [], updatedAt: null };
    const out = mergeBrief(empty, { why: 'because' }, NOW);
    expect(out).toEqual({ why: 'because', doing: '', where: '', pictures: [], updatedAt: NOW });
  });

  test('omitting pictures keeps the stored list', () => {
    const stored = [pic('a.png'), pic('b.png')];
    const out = mergeBrief(b({ pictures: stored }), { doing: 'new doing' }, NOW);
    expect(out.pictures).toEqual(stored);
  });

  test('a given list replaces the stored one whole, in its order', () => {
    const out = mergeBrief(
      b({ pictures: [pic('a.png'), pic('b.png')] }),
      { pictures: [pic('c.png'), pic('a.png')] },
      NOW
    );
    expect(out.pictures).toEqual([pic('c.png'), pic('a.png')]);
    expect(out.updatedAt).toBe(NOW);
  });

  test('an empty list clears the pictures', () => {
    const out = mergeBrief(b({ pictures: [pic('a.png')] }), { pictures: [] }, NOW);
    expect(out.pictures).toEqual([]);
    expect(out.updatedAt).toBe(NOW);
  });

  test('the same pictures again leave updatedAt alone', () => {
    const stored = [pic('a.png', 'A'), pic('b.png', 'B')];
    const out = mergeBrief(b({ pictures: stored, updatedAt: 42 }), { pictures: [...stored] }, NOW);
    expect(out.updatedAt).toBe(42);
  });

  test('reordering or recaptioning is a change', () => {
    const stored = [pic('a.png', 'A'), pic('b.png', 'B')];
    const before = b({ pictures: stored, updatedAt: 42 });
    expect(mergeBrief(before, { pictures: [stored[1], stored[0]] }, NOW).updatedAt).toBe(NOW);
    expect(mergeBrief(before, { pictures: [pic('a.png', 'A2'), stored[1]] }, NOW).updatedAt).toBe(
      NOW
    );
  });
});

describe('isBlank', () => {
  test('all three empty is blank', () => {
    expect(isBlank({ why: '', doing: '', where: '', pictures: [], updatedAt: null })).toBe(true);
  });
  test('one field is enough to be worth storing', () => {
    expect(isBlank({ why: '', doing: 'x', where: '', pictures: [], updatedAt: null })).toBe(false);
  });
  test('pictures alone are worth storing', () => {
    expect(
      isBlank({ why: '', doing: '', where: '', pictures: [pic('a.png')], updatedAt: null })
    ).toBe(false);
  });
});

describe('sameContent', () => {
  test('ignores the timestamp', () => {
    expect(sameContent(b({ updatedAt: 1 }), b({ updatedAt: 999 }))).toBe(true);
  });
});

describe('resolveBriefPictures', () => {
  let pub: string;
  let scope: PictureScope;

  beforeAll(async () => {
    pub = await mkdtemp(join(tmpdir(), 'brief-pictures-'));
    const files = [
      'owner/repo/how-it-works/1-overview.png',
      'owner/repo/how-it-works/2-flow.svg',
      'owner/repo/notes.txt',
      'owner/repo/.thumbs/x.png',
      'owner/repo/nested/inner.png',
      'owner/other/theirs.png',
      'stray/loose.png',
    ];
    for (const f of files) {
      await mkdir(dirname(join(pub, f)), { recursive: true });
      await writeFile(join(pub, f), 'x');
    }
    await mkdir(join(pub, 'owner/repo/folder.png'), { recursive: true });
    scope = {
      publicRoot: pub,
      projectName: 'owner/repo',
      otherProjectNames: ['owner/other', 'owner/repo/nested'],
    };
  });
  afterAll(async () => {
    await removeTempTree(pub);
  });

  const reject = async (raw: unknown, mention: string): Promise<void> => {
    const out = await resolveBriefPictures(raw, scope);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain(mention);
  };

  test('accepts relative and absolute paths, stored relative and in order', async () => {
    const out = await resolveBriefPictures(
      [
        { path: 'how-it-works/2-flow.svg', caption: ' Flow ' },
        { path: join(pub, 'owner/repo/how-it-works/1-overview.png'), caption: 'Overview' },
      ],
      scope
    );
    expect(out).toEqual({
      ok: true,
      pictures: [
        { path: 'how-it-works/2-flow.svg', caption: 'Flow' },
        { path: 'how-it-works/1-overview.png', caption: 'Overview' },
      ],
    });
  });

  test('an empty list is valid and clears', async () => {
    expect(await resolveBriefPictures([], scope)).toEqual({ ok: true, pictures: [] });
  });

  test('a path outside the project folder is refused, naming it', async () => {
    await reject(
      [{ path: '../../stray/loose.png', caption: 'c' }],
      'pictures[0] (../../stray/loose.png) is outside'
    );
    await reject([{ path: '/etc/passwd.png', caption: 'c' }], 'is outside');
  });

  test("another project's picture is refused", async () => {
    await reject([{ path: '../other/theirs.png', caption: 'c' }], "project owner/other's picture");
    await reject(
      [{ path: 'nested/inner.png', caption: 'c' }],
      "project owner/repo/nested's picture"
    );
  });

  test('a missing file is refused', async () => {
    await reject([{ path: 'how-it-works/gone.png', caption: 'c' }], 'does not exist');
  });

  test('a non-image is refused', async () => {
    await reject([{ path: 'notes.txt', caption: 'c' }], 'is not a picture');
  });

  test('a folder with a picture name is refused', async () => {
    await reject([{ path: 'folder.png', caption: 'c' }], 'is not a file');
  });

  test('a hidden folder is refused', async () => {
    await reject([{ path: '.thumbs/x.png', caption: 'c' }], 'hidden folder');
  });

  test('one bad entry rejects the whole list and names the bad one', async () => {
    await reject(
      [
        { path: 'how-it-works/1-overview.png', caption: 'ok' },
        { path: 'how-it-works/gone.png', caption: 'bad' },
      ],
      'pictures[1] (how-it-works/gone.png) does not exist'
    );
  });

  test('a malformed entry is refused', async () => {
    await reject('a.png', 'must be a list');
    await reject(['a.png'], 'pictures[0] must be an object');
    await reject([{ caption: 'c' }], 'pictures[0] has no path');
    await reject([{ path: 'how-it-works/1-overview.png' }], 'has no caption');
    await reject([{ path: 'how-it-works/1-overview.png', caption: '  ' }], 'has no caption');
  });

  test('the same picture twice is refused', async () => {
    const one = { path: 'how-it-works/1-overview.png', caption: 'c' };
    await reject([one, one], 'pictures[1] (how-it-works/1-overview.png) is listed twice');
  });

  test(`more than ${String(MAX_BRIEF_PICTURES)} pictures is refused`, async () => {
    const many = Array.from({ length: MAX_BRIEF_PICTURES + 1 }, () => ({
      path: 'how-it-works/1-overview.png',
      caption: 'c',
    }));
    await reject(many, `the most a brief shows is ${String(MAX_BRIEF_PICTURES)}`);
  });
});
