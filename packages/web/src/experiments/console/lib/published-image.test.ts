import { describe, expect, test } from 'bun:test';
import { sameOriginFallback } from './published-image';

const PHONE = 'https://archon-cloud.example.ts.net';

describe('sameOriginFallback', () => {
  test('a published file on the public address retries at the page origin', () => {
    expect(sameOriginFallback('https://archon.example.io/files/archon/x/a b.png', PHONE)).toBe(
      `${PHONE}/files/archon/x/a%20b.png`
    );
  });

  test('keeps the query string', () => {
    expect(sameOriginFallback('https://archon.example.io/files/a.png?v=2', PHONE)).toBe(
      `${PHONE}/files/a.png?v=2`
    );
  });

  test('an image already on the page origin has nowhere else to go', () => {
    expect(sameOriginFallback(`${PHONE}/files/a.png`, PHONE)).toBeNull();
    expect(sameOriginFallback('/files/a.png', PHONE)).toBeNull();
  });

  test('a foreign path that is not a published file is left alone', () => {
    expect(sameOriginFallback('https://example.com/assets/a.png', PHONE)).toBeNull();
    expect(sameOriginFallback('https://example.com/filesystem.png', PHONE)).toBeNull();
  });

  test('an unparseable src is left alone', () => {
    expect(sameOriginFallback('http://[bad', PHONE)).toBeNull();
  });
});
