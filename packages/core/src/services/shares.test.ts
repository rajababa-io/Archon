import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { Share } from '../db/shares';
import {
  normalizeSharePath,
  publishedEntry,
  resolveShareRequest,
  shareAddress,
  shareTarget,
  targetAddress,
} from './shares';

const track = trackTempRoots();

/**
 * A public root holding a deck folder and a lone image, and a folder outside
 * the root holding a secret. Links in the tests point at that FOLDER, as a
 * junction, because a file symlink needs a privilege Windows does not grant by
 * default; a link to a folder escapes just as well.
 */
function fixture(): { root: string; outside: string } {
  const top = track(mkdtempSync(join(tmpdir(), 'shares-')));
  const root = join(top, 'public');
  const outside = join(top, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  mkdirSync(join(root, 'archon/deck/img'), { recursive: true });
  writeFileSync(join(root, 'archon/deck/index.html'), '<h1>deck</h1>');
  writeFileSync(join(root, 'archon/deck/img/a.png'), 'png');
  writeFileSync(join(root, 'archon/pic.png'), 'pic');
  return { root, outside };
}

const share = (path: string, access: Share['access'] = 'link'): Share => ({
  code: 'abc',
  path,
  access,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('normalizeSharePath', () => {
  test('accepts every spelling of the private address', () => {
    for (const input of [
      'https://archon.example.com/files/archon/deck/index.html',
      '/files/archon/deck/index.html',
      'files/archon/deck/index.html',
      'archon/deck/index.html',
    ]) {
      expect(normalizeSharePath(input)).toEqual({ ok: true, path: 'archon/deck/index.html' });
    }
    expect(normalizeSharePath('/files/archon/deck/')).toEqual({ ok: true, path: 'archon/deck' });
    expect(normalizeSharePath('/files/a%20b/c')).toEqual({ ok: true, path: 'a b/c' });
  });

  test('refuses empty paths and anything that could climb', () => {
    for (const input of [
      '',
      '/files/',
      '/files/../etc',
      'a/./b',
      'a//b',
      'a\\b',
      '%2e%2e/x',
      '%zz',
    ]) {
      expect(normalizeSharePath(input).ok).toBe(false);
    }
  });
});

describe('publishedEntry', () => {
  test('tells a folder from a file, and refuses what is missing or outside the root', async () => {
    const { root, outside } = fixture();
    symlinkSync(outside, join(root, 'archon/escape'), 'junction');
    expect(await publishedEntry(root, 'archon/deck')).toBe('dir');
    expect(await publishedEntry(root, 'archon/pic.png')).toBe('file');
    expect(await publishedEntry(root, 'archon/nope')).toBeNull();
    expect(await publishedEntry(root, 'archon/escape')).toBeNull();
    expect(await publishedEntry(root, 'archon/escape/secret.txt')).toBeNull();
  });
});

describe('resolveShareRequest', () => {
  test('a folder serves its index and the files below it', async () => {
    const { root } = fixture();
    const deck = share('archon/deck');
    expect(await resolveShareRequest(root, deck, '', true)).toEqual({
      kind: 'file',
      file: expect.stringMatching(/archon[\\/]deck[\\/]index\.html$/),
    });
    expect(await resolveShareRequest(root, deck, 'img/a.png', true)).toEqual({
      kind: 'file',
      file: expect.stringMatching(/img[\\/]a\.png$/),
    });
  });

  test('a folder asked for without its slash is redirected, so relative links resolve', async () => {
    const { root } = fixture();
    expect(await resolveShareRequest(root, share('archon/deck'), '', false)).toEqual({
      kind: 'redirect',
      location: '/share/abc/',
    });
  });

  test('a shared file has no children', async () => {
    const { root } = fixture();
    const pic = share('archon/pic.png');
    expect((await resolveShareRequest(root, pic, '', false)).kind).toBe('file');
    expect((await resolveShareRequest(root, pic, 'x', true)).kind).toBe('missing');
  });

  test('nothing outside the shared folder is reachable', async () => {
    const { root, outside } = fixture();
    symlinkSync(outside, join(root, 'archon/deck/leak'), 'junction');
    const deck = share('archon/deck');
    for (const rest of [
      '../pic.png',
      '%2e%2e/pic.png',
      '..%2fpic.png',
      'leak/secret.txt',
      'leak/',
      'missing.png',
    ]) {
      expect((await resolveShareRequest(root, deck, rest, true)).kind).toBe('missing');
    }
  });

  test('a restricted share answers as if it did not exist', async () => {
    const { root } = fixture();
    expect(
      (await resolveShareRequest(root, share('archon/deck', 'restricted'), '', true)).kind
    ).toBe('missing');
  });
});

describe('shareTarget', () => {
  test('a web page is shared with its folder, landing on the page', async () => {
    const { root } = fixture();
    writeFileSync(join(root, 'archon/deck/notes.html'), 'notes');
    expect(await shareTarget(root, 'archon/deck/index.html')).toEqual({
      path: 'archon/deck',
      kind: 'dir',
      page: '',
    });
    const notes = await shareTarget(root, 'archon/deck/notes.html');
    expect(notes).toEqual({ path: 'archon/deck', kind: 'dir', page: 'notes.html' });
    expect(targetAddress('abc', notes!)).toBe('/share/abc/notes.html');
  });

  test('any other file is shared alone, a folder as itself, and nothing as null', async () => {
    const { root } = fixture();
    expect(await shareTarget(root, 'archon/pic.png')).toEqual({
      path: 'archon/pic.png',
      kind: 'file',
      page: '',
    });
    expect(await shareTarget(root, 'archon/deck')).toEqual({
      path: 'archon/deck',
      kind: 'dir',
      page: '',
    });
    expect(await shareTarget(root, 'archon/none.html')).toBeNull();
  });
});

test('shareAddress ends a folder in a slash', () => {
  expect(shareAddress('abc', 'dir')).toBe('/share/abc/');
  expect(shareAddress('abc', 'file')).toBe('/share/abc');
});
