/**
 * An append-only log file that rotates by size: `server.log` → `server.log.1`
 * → … → `server.log.<keep>`, the oldest overwritten, so the total on disk is
 * bounded by roughly `(keep + 1) * maxBytes`.
 *
 * Writes are synchronous on the caller's thread. pino-roll and other pino file
 * transports run in a worker thread, which needs a `require.resolve` that
 * fails inside a compiled binary's `/$bunfs/` filesystem (see `logger.ts`).
 * Every method throws on an fs failure; the caller decides where logs go next.
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'fs';
import { dirname } from 'path';

export interface RotationLimits {
  /** Rotate before a write that would take the live file past this size. */
  maxBytes: number;
  /** Rotated files kept beside the live one; at least 1. */
  keep: number;
}

export interface RotatingLogFile {
  write(line: string): void;
  close(): void;
}

export function openRotatingLogFile(path: string, limits: RotationLimits): RotatingLogFile {
  if (!Number.isInteger(limits.keep) || limits.keep < 1) {
    throw new Error(`Log rotation must keep at least one old file, got ${limits.keep}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  let fd = openSync(path, 'a');
  let size = fstatSync(fd).size;

  function rotate(): void {
    closeSync(fd);
    for (let i = limits.keep - 1; i >= 1; i--) {
      if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    }
    renameSync(path, `${path}.1`);
    fd = openSync(path, 'a');
    size = 0;
  }

  return {
    write(line: string): void {
      const bytes = Buffer.byteLength(line);
      // A line longer than maxBytes still lands whole, alone in its own file.
      if (size > 0 && size + bytes > limits.maxBytes) rotate();
      writeSync(fd, line);
      size += bytes;
    },
    close(): void {
      closeSync(fd);
    },
  };
}
