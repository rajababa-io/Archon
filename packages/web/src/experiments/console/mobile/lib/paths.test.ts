import { describe, expect, test } from 'bun:test';
import { directoryPath, filePath, parseProjectTab, projectPath, runPath } from './paths';

describe('parseProjectTab', () => {
  test('no segment is the overview', () => {
    expect(parseProjectTab(undefined)).toBe('overview');
    expect(parseProjectTab('')).toBe('overview');
  });

  test('a named tab is that tab', () => {
    expect(parseProjectTab('runs')).toBe('runs');
    expect(parseProjectTab('files')).toBe('files');
  });

  test('anything else names no tab', () => {
    expect(parseProjectTab('settings')).toBeNull();
    expect(parseProjectTab('Runs')).toBeNull();
  });
});

describe('paths', () => {
  test('the overview is the project path itself; every other tab adds its name', () => {
    expect(projectPath('p 1')).toBe('/m/p/p%201');
    expect(projectPath('p 1', 'overview')).toBe('/m/p/p%201');
    expect(projectPath('p 1', 'issues')).toBe('/m/p/p%201/issues');
  });

  test('the root directory is the Files tab; a sub-directory rides in the query', () => {
    expect(directoryPath('p', '')).toBe('/m/p/p/files');
    expect(directoryPath('p', 'src/a b')).toBe('/m/p/p/files?dir=src%2Fa%20b');
  });

  test('a file keeps its slashes and encodes each part', () => {
    expect(filePath('p', 'docs/read me.md')).toBe('/m/files/p/docs/read%20me.md');
    expect(filePath('p', 'a#b/c?.ts')).toBe('/m/files/p/a%23b/c%3F.ts');
  });

  test('a run id is encoded', () => {
    expect(runPath('run/1')).toBe('/m/r/run%2F1');
  });
});
