import { describe, expect, test } from 'bun:test';
import { codeFence, fileView } from './file-view';

describe('fileView', () => {
  test('raster images open as pictures, markdown renders, everything else is code', () => {
    expect(fileView('docs/shot.PNG')).toBe('image');
    expect(fileView('README.md')).toBe('markdown');
    expect(fileView('src/app.ts')).toBe('code');
    // A script-bearing document is shown as its source, as on the desktop.
    expect(fileView('logo.svg')).toBe('code');
  });
});

describe('codeFence', () => {
  test('fences the text with the language the path names', () => {
    expect(codeFence('const a = 1;', 'src/a.ts')).toBe('```typescript\nconst a = 1;\n```');
  });

  test('an unknown extension gets a bare fence', () => {
    expect(codeFence('x', 'notes.txt')).toBe('```\nx\n```');
  });

  test('a fence inside the file cannot close the block', () => {
    const text = 'before\n````js\ncode\n````\nafter';
    const fenced = codeFence(text, 'README');
    expect(fenced.startsWith('`````\n')).toBe(true);
    expect(fenced.endsWith('\n`````')).toBe(true);
  });
});
