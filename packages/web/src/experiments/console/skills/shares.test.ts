import { describe, expect, test } from 'bun:test';
import { publishedPath } from './shares';

describe('publishedPath', () => {
  test("a published file on any of this server's addresses is shareable", () => {
    expect(publishedPath('https://archon.example.com/files/archon/deck/index.html')).toBe(
      '/files/archon/deck/index.html'
    );
    expect(publishedPath('/files/archon/pic.png')).toBe('/files/archon/pic.png');
  });

  test('anything outside the publishing directory is not', () => {
    for (const href of [
      'https://github.com/x/y',
      '/files/',
      '/assets/app.js',
      '/share/abc/',
      'mailto:a@b.c',
      'javascript:alert(1)',
    ]) {
      expect(publishedPath(href)).toBeNull();
    }
  });
});
