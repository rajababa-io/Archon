import { describe, expect, test } from 'bun:test';
import { briefParts } from './brief-links';

const hrefs = (value: string): string[] =>
  briefParts(value).flatMap(p => (p.kind === 'link' ? [p.href] : []));

describe('briefParts', () => {
  test('plain text is one untouched part', () => {
    expect(briefParts('Keeps the door code in sync. * not a list #3')).toEqual([
      { kind: 'text', text: 'Keeps the door code in sync. * not a list #3' },
    ]);
    expect(briefParts('')).toEqual([]);
  });

  test('a bare address becomes a link', () => {
    expect(briefParts('App: https://wix-access.vercel.app now')).toEqual([
      { kind: 'text', text: 'App: ' },
      {
        kind: 'link',
        text: 'https://wix-access.vercel.app',
        href: 'https://wix-access.vercel.app',
        label: 'https://wix-access.vercel.app',
      },
      { kind: 'text', text: ' now' },
    ]);
  });

  test('trailing punctuation stays outside the link', () => {
    expect(hrefs('See https://a.example/x.')).toEqual(['https://a.example/x']);
    expect(hrefs('https://a.example, https://b.example;')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(hrefs('(see https://a.example)')).toEqual(['https://a.example']);
    expect(hrefs('https://a.example·')).toEqual(['https://a.example']);
    expect(briefParts('(see https://a.example).').at(-1)).toEqual({ kind: 'text', text: ').' });
  });

  test('a parenthesis the address opened is kept', () => {
    expect(hrefs('https://en.wikipedia.org/wiki/X_(y)')).toEqual([
      'https://en.wikipedia.org/wiki/X_(y)',
    ]);
  });

  test('the dot-separated links list splits into each address', () => {
    expect(hrefs('https://unifi.ui.com · https://manage.wix.com · http://localhost:3000')).toEqual([
      'https://unifi.ui.com',
      'https://manage.wix.com',
      'http://localhost:3000',
    ]);
  });

  test('other schemes stay text', () => {
    for (const s of ['javascript:alert(1)', 'mailto:a@b.example', 'ftp://a.example', 'a.example']) {
      expect(briefParts(s)).toEqual([{ kind: 'text', text: s }]);
    }
    expect(briefParts('[x](javascript:alert(1))').some(p => p.kind === 'link')).toBe(false);
    expect(briefParts('https://')).toEqual([{ kind: 'text', text: 'https://' }]);
  });

  test('a markdown link shows its label', () => {
    expect(briefParts('Errors in [Sentry](https://sentry.io/x).')).toEqual([
      { kind: 'text', text: 'Errors in ' },
      {
        kind: 'link',
        text: '[Sentry](https://sentry.io/x)',
        href: 'https://sentry.io/x',
        label: 'Sentry',
      },
      { kind: 'text', text: '.' },
    ]);
  });

  test('joining every part gives the field back', () => {
    const value = 'A [b](https://b.example) c https://d.example/e). f javascript:g';
    expect(
      briefParts(value)
        .map(p => p.text)
        .join('')
    ).toBe(value);
  });
});
