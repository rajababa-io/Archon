import { describe, expect, test } from 'bun:test';
import { MANIFEST_PATH } from '../pwa/paths';
import { MANIFEST_LINK } from './head';

describe('MANIFEST_LINK', () => {
  test('asks for the manifest with cookies, so an auth proxy lets it through', () => {
    expect(MANIFEST_LINK).toEqual({
      rel: 'manifest',
      href: MANIFEST_PATH,
      crossorigin: 'use-credentials',
    });
  });
});
