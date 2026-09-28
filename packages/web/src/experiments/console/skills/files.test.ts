import { describe, expect, test } from 'bun:test';
import { rawFileUrl, repoImageUrl } from './files';

describe('repoImageUrl', () => {
  test('a relative image is read from beside the document', () => {
    expect(repoImageUrl('p', 'docs/guide.md', './shots/a.png')).toBe(
      rawFileUrl('p', 'docs/shots/a.png')
    );
    expect(repoImageUrl('p', 'README.md', 'logo.png')).toBe(rawFileUrl('p', 'logo.png'));
  });

  test('an absolute or protocol-relative image is left alone', () => {
    expect(repoImageUrl('p', 'README.md', 'https://x.test/a.png')).toBe('https://x.test/a.png');
    expect(repoImageUrl('p', 'README.md', '//cdn.test/a.png')).toBe('//cdn.test/a.png');
  });
});
