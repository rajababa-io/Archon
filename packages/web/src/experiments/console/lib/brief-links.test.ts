import { describe, expect, test } from 'bun:test';
import { splitBriefLinks } from './brief-links';

const SHARE = 'https://archon.rajababa.io/share/xjBHrkLpgRztS1HfKRvykg/';

describe('splitBriefLinks', () => {
  test('text with no address comes back as one unchanged run', () => {
    const text = 'Ship *the* `van` screen_v2 [draft] (soon).';
    expect(splitBriefLinks(text)).toEqual([{ kind: 'text', text }]);
  });

  test('empty text yields nothing', () => {
    expect(splitBriefLinks('')).toEqual([]);
  });

  test('a bare address becomes a link and the prose around it survives', () => {
    expect(splitBriefLinks(`Live prototype at ${SHARE} — awaiting photos.`)).toEqual([
      { kind: 'text', text: 'Live prototype at ' },
      { kind: 'link', href: SHARE, label: SHARE },
      { kind: 'text', text: ' — awaiting photos.' },
    ]);
  });

  test('sentence punctuation after an address is not part of it', () => {
    expect(splitBriefLinks('See http://x.dev/a. Then https://y.dev/b, done')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', href: 'http://x.dev/a', label: 'http://x.dev/a' },
      { kind: 'text', text: '. Then ' },
      { kind: 'link', href: 'https://y.dev/b', label: 'https://y.dev/b' },
      { kind: 'text', text: ', done' },
    ]);
  });

  test('a wrapping paren is dropped, a balanced one inside the path is kept', () => {
    expect(splitBriefLinks('(see https://x.dev/a)')).toEqual([
      { kind: 'text', text: '(see ' },
      { kind: 'link', href: 'https://x.dev/a', label: 'https://x.dev/a' },
      { kind: 'text', text: ')' },
    ]);
    const wiki = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    expect(splitBriefLinks(wiki)).toEqual([{ kind: 'link', href: wiki, label: wiki }]);
  });

  test('[label](url) becomes a labelled link', () => {
    expect(splitBriefLinks(`Open [the prototype](${SHARE}) now`)).toEqual([
      { kind: 'text', text: 'Open ' },
      { kind: 'link', href: SHARE, label: 'the prototype' },
      { kind: 'text', text: ' now' },
    ]);
  });

  test('only http(s) addresses link — other schemes stay text', () => {
    const text = 'javascript:alert(1) and [x](javascript:alert(1)) and https:// alone';
    expect(splitBriefLinks(text)).toEqual([{ kind: 'text', text }]);
  });
});
