import { describe, expect, test } from 'bun:test';
import { rankPaths } from './fuzzy-path';

const PATHS = [
  'packages/web/src/experiments/console/components/ChatComposer.tsx',
  'packages/web/src/experiments/console/mobile/components/Composer.tsx',
  'packages/web/src/experiments/console/lib/composer-history.ts',
  'packages/server/src/index.ts',
  'README.md',
  'docs/composer.md',
];

describe('rankPaths', () => {
  test('an exact file name beats a longer name that starts with it', () => {
    expect(rankPaths(PATHS, 'composer.tsx', 3)[0]).toBe(
      'packages/web/src/experiments/console/mobile/components/Composer.tsx'
    );
  });

  test('a name that starts with the query beats one that only contains it', () => {
    const ranked = rankPaths(PATHS, 'composer', 10);
    expect(ranked.indexOf('docs/composer.md')).toBeLessThan(
      ranked.indexOf('packages/web/src/experiments/console/components/ChatComposer.tsx')
    );
  });

  test('letters in order find a file', () => {
    expect(rankPaths(PATHS, 'rdme', 5)).toEqual(['README.md']);
  });

  test('ignores case and spaces', () => {
    expect(rankPaths(PATHS, 'READ me', 5)).toEqual(['README.md']);
  });

  test('a match in the directory only still counts, behind the file names', () => {
    const ranked = rankPaths(PATHS, 'server', 5);
    expect(ranked).toEqual(['packages/server/src/index.ts']);
  });

  test('an empty query and a miss find nothing', () => {
    expect(rankPaths(PATHS, '', 5)).toEqual([]);
    expect(rankPaths(PATHS, 'zzz', 5)).toEqual([]);
  });

  test('stops at the limit', () => {
    expect(rankPaths(PATHS, 'e', 2)).toHaveLength(2);
  });
});
