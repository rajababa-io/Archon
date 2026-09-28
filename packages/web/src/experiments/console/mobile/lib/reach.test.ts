import { describe, expect, test } from 'bun:test';
import { HttpError } from '../../lib/http';
import { reachOf } from './reach';

const status = (code: number): HttpError => new HttpError(code, '/api/conversations', '');

describe('reachOf', () => {
  test('the phone saying it has no network wins over everything', () => {
    expect(reachOf(false, undefined)).toBe('offline');
    expect(reachOf(false, new TypeError('Failed to fetch'))).toBe('offline');
  });

  test('a read that never got an answer means Archon is out of reach', () => {
    expect(reachOf(true, new TypeError('Failed to fetch'))).toBe('unreachable');
  });

  test('a proxy answering for Archon means Archon is out of reach', () => {
    for (const code of [502, 503, 504]) expect(reachOf(true, status(code))).toBe('unreachable');
  });

  test("Archon's own error is an answer: reachable, and the screen reports it", () => {
    for (const code of [400, 401, 404, 500]) expect(reachOf(true, status(code))).toBe('online');
  });

  test('a clean read is online', () => {
    expect(reachOf(true, undefined)).toBe('online');
  });
});
