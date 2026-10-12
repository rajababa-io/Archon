import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openRotatingLogFile } from './rotating-log-file';
import { trackTempRoots } from './test-utils';

const trackTempRoot = trackTempRoots();

function scratchLog(): string {
  return join(trackTempRoot(mkdtempSync(join(tmpdir(), 'rotating-log-'))), 'logs', 'server.log');
}

describe('openRotatingLogFile', () => {
  it('creates the directory and appends to an existing file', () => {
    const path = scratchLog();
    const first = openRotatingLogFile(path, { maxBytes: 1000, keep: 2 });
    first.write('one\n');
    first.close();
    const second = openRotatingLogFile(path, { maxBytes: 1000, keep: 2 });
    second.write('two\n');
    second.close();

    expect(readFileSync(path, 'utf8')).toBe('one\ntwo\n');
  });

  it('rotates before a write would pass maxBytes and keeps only `keep` old files', () => {
    const path = scratchLog();
    const file = openRotatingLogFile(path, { maxBytes: 8, keep: 2 });
    for (const line of ['a1\n', 'a2\n', 'b1\n', 'b2\n', 'c1\n', 'c2\n', 'd1\n']) file.write(line);
    file.close();

    expect(readFileSync(path, 'utf8')).toBe('d1\n');
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('c1\nc2\n');
    expect(readFileSync(`${path}.2`, 'utf8')).toBe('b1\nb2\n');
    expect(existsSync(`${path}.3`)).toBe(false);
  });

  it('counts the size already on disk when reopening', () => {
    const path = scratchLog();
    const file = openRotatingLogFile(path, { maxBytes: 8, keep: 1 });
    file.write('abcdef\n');
    file.close();

    const reopened = openRotatingLogFile(path, { maxBytes: 8, keep: 1 });
    reopened.write('gh\n');
    reopened.close();

    expect(readFileSync(path, 'utf8')).toBe('gh\n');
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('abcdef\n');
  });

  it('writes a line longer than maxBytes whole', () => {
    const path = scratchLog();
    const file = openRotatingLogFile(path, { maxBytes: 4, keep: 1 });
    file.write('long line\n');
    file.close();

    expect(readFileSync(path, 'utf8')).toBe('long line\n');
  });

  it('throws when the file cannot be opened', () => {
    const blocker = join(trackTempRoot(mkdtempSync(join(tmpdir(), 'rotating-log-'))), 'not-a-dir');
    writeFileSync(blocker, '');

    expect(() =>
      openRotatingLogFile(join(blocker, 'server.log'), { maxBytes: 8, keep: 1 })
    ).toThrow();
  });

  it('refuses to rotate without keeping an old file', () => {
    expect(() => openRotatingLogFile(scratchLog(), { maxBytes: 8, keep: 0 })).toThrow(
      'at least one old file'
    );
  });
});
