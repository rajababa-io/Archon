import { describe, expect, test } from 'bun:test';
import { shellFiles, type BundleItem } from './precache';

function chunk(
  fileName: string,
  opts: { isEntry?: boolean; imports?: string[]; css?: string[] } = {}
): BundleItem {
  return {
    type: 'chunk',
    fileName,
    isEntry: opts.isEntry ?? false,
    imports: opts.imports ?? [],
    viteMetadata: { importedCss: new Set(opts.css ?? []) },
  };
}

describe('shellFiles', () => {
  test('the entry, its static imports and their CSS, and nothing lazy', () => {
    const bundle: Record<string, BundleItem> = {
      'assets/index-a.js': chunk('assets/index-a.js', {
        isEntry: true,
        imports: ['assets/vendor-b.js'],
        css: ['assets/index-a.css'],
      }),
      'assets/vendor-b.js': chunk('assets/vendor-b.js', { css: ['assets/vendor-b.css'] }),
      'assets/FilesPage-c.js': chunk('assets/FilesPage-c.js'),
      'assets/index-a.css': { type: 'asset', fileName: 'assets/index-a.css' },
      'assets/logo.png': { type: 'asset', fileName: 'assets/logo.png' },
    };
    expect(shellFiles(bundle)).toEqual([
      '/assets/index-a.css',
      '/assets/index-a.js',
      '/assets/vendor-b.css',
      '/assets/vendor-b.js',
    ]);
  });

  test('a shared import reached twice is listed once, and a cycle terminates', () => {
    const bundle: Record<string, BundleItem> = {
      'a.js': chunk('a.js', { isEntry: true, imports: ['b.js', 'c.js'] }),
      'b.js': chunk('b.js', { imports: ['c.js'] }),
      'c.js': chunk('c.js', { imports: ['b.js'] }),
    };
    expect(shellFiles(bundle)).toEqual(['/a.js', '/b.js', '/c.js']);
  });
});
