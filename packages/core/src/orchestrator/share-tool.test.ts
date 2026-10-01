import { describe, expect, test } from 'bun:test';
import type { Share, ShareAccess } from '../db/shares';
import type { ShareTarget } from '../services/shares';
import { buildShareTool, SHARED, UNSHARED } from './share-tool';

function harness(entries: Record<string, ShareTarget>): {
  tool: ReturnType<typeof buildShareTool>;
  sets: [string, ShareAccess][];
} {
  const sets: [string, ShareAccess][] = [];
  const tool = buildShareTool({
    target: async path => entries[path] ?? null,
    set: async (path, access): Promise<Share> => {
      sets.push([path, access]);
      return { code: 'CODE', path, access, createdAt: new Date(), updatedAt: new Date() };
    },
  });
  return { tool, sets };
}

describe('share_page', () => {
  test('shares a published folder at a slash-ended address', async () => {
    const { tool, sets } = harness({
      'archon/deck': { path: 'archon/deck', kind: 'dir', page: '' },
    });
    const out = await tool.handler({ path: 'https://archon.example.com/files/archon/deck/' });
    expect(sets).toEqual([['archon/deck', 'link']]);
    expect(out.startsWith(SHARED)).toBe(true);
    expect(out).toContain('/share/CODE/');
  });

  test('a web page shares its folder and the address lands on the page', async () => {
    const { tool, sets } = harness({
      'archon/deck/slides.html': { path: 'archon/deck', kind: 'dir', page: 'slides.html' },
    });
    const out = await tool.handler({ path: '/files/archon/deck/slides.html' });
    expect(sets).toEqual([['archon/deck', 'link']]);
    expect(out).toMatch(/\/share\/CODE\/slides\.html$/);
  });

  test('a file gets an address without the slash', async () => {
    const { tool } = harness({
      'archon/pic.png': { path: 'archon/pic.png', kind: 'file', page: '' },
    });
    expect(await tool.handler({ path: '/files/archon/pic.png' })).toMatch(/\/share\/CODE$/);
  });

  test('refuses what is not published, and never writes', async () => {
    const { tool, sets } = harness({});
    expect(await tool.handler({ path: '/files/archon/nope' })).toContain('nothing is published');
    expect(await tool.handler({ path: '/files/../etc/passwd' })).toContain('share_page error');
    expect(await tool.handler({ path: 42 })).toContain('share_page error');
    expect(sets).toEqual([]);
  });

  test('restricted turns a share off even when the file is gone', async () => {
    const { tool, sets } = harness({});
    const out = await tool.handler({ path: '/files/archon/deck/', access: 'restricted' });
    expect(sets).toEqual([['archon/deck', 'restricted']]);
    expect(out.startsWith(UNSHARED)).toBe(true);
  });

  test('an access value that is neither is refused, not guessed', async () => {
    const { tool, sets } = harness({ a: { path: 'a', kind: 'file', page: '' } });
    expect(await tool.handler({ path: 'a', access: 'Restricted ' })).toContain('share_page error');
    expect(await tool.handler({ path: 'a', access: 'public' })).toContain('share_page error');
    expect(sets).toEqual([]);
  });

  test('a failure comes back as text rather than a throw', async () => {
    const tool = buildShareTool({
      target: async () => ({ path: 'a', kind: 'dir', page: '' }),
      set: () => Promise.reject(new Error('db gone')),
    });
    expect(await tool.handler({ path: 'a' })).toContain('db gone');
  });
});
