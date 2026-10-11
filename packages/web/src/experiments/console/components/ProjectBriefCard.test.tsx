import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectPicture } from '../skills';
import type { ProjectBrief } from '../primitives/project';
import {
  BriefPictureStrip,
  BriefText,
  ProjectBriefView,
  shownPictures,
  type ShownPicture,
} from './ProjectBriefCard';

const listed = (path: string, thumb = true): ProjectPicture => ({
  path,
  topic: null,
  name: path,
  url: `/files/p/${path}`,
  thumbUrl: thumb ? `/files/.thumbs/p/${path}.webp` : null,
  modifiedAt: '2026-10-11T00:00:00Z',
  bytes: 1,
});
const shown = (path: string, caption: string): ShownPicture => ({
  picture: listed(path),
  caption,
});

describe('BriefText', () => {
  test('an address opens in a new tab without handing over the opener', () => {
    const html = renderToStaticMarkup(<BriefText text="Prototype: https://x.dev/p/ live" />);
    expect(html).toContain('<a href="https://x.dev/p/" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('>https://x.dev/p/</a> live');
  });

  test('markup in the brief is printed, never rendered', () => {
    const html = renderToStaticMarkup(<BriefText text={'<img src=x onerror="a()"> plain'} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('ProjectBriefView', () => {
  const brief: ProjectBrief = {
    why: 'w',
    doing: 'd',
    where: 'r',
    pictures: [],
    updatedAt: null,
  };

  test('a brief with no pictures draws no picture at all', () => {
    const html = renderToStaticMarkup(<ProjectBriefView projectId="p" brief={brief} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('/files/');
    expect(html).toContain('Why');
  });
});

describe('shownPictures', () => {
  test("keeps the brief's order and captions, leaving out what the server no longer lists", () => {
    const out = shownPictures(
      [
        { path: 'b.png', caption: 'Second' },
        { path: 'gone.png', caption: 'Gone' },
        { path: 'a.png', caption: 'First' },
      ],
      [listed('a.png'), listed('b.png')]
    );
    expect(out.map(s => [s.picture.path, s.caption])).toEqual([
      ['b.png', 'Second'],
      ['a.png', 'First'],
    ]);
  });
});

describe('BriefPictureStrip', () => {
  test('no pictures draws nothing', () => {
    expect(renderToStaticMarkup(<BriefPictureStrip shown={[]} />)).toBe('');
  });

  test('one picture is drawn large from its thumbnail, captioned, opening full size', () => {
    const html = renderToStaticMarkup(
      <BriefPictureStrip shown={[shown('a.png', 'How it works')]} />
    );
    expect(html).toContain('href="/files/p/a.png" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('src="/files/.thumbs/p/a.png.webp"');
    expect(html).not.toContain('src="/files/p/a.png"');
    expect(html).toContain('How it works');
    expect(html.match(/<img/g)).toHaveLength(1);
  });

  test('many pictures keep their order: the first large, the rest as thumbnails', () => {
    const html = renderToStaticMarkup(
      <BriefPictureStrip
        shown={[shown('1.png', 'One'), shown('2.png', 'Two'), shown('3.png', 'Three')]}
      />
    );
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    expect(hrefs).toEqual(['/files/p/1.png', '/files/p/2.png', '/files/p/3.png']);
    expect(html.match(/target="_blank"/g)).toHaveLength(3);
    expect(html.indexOf('One')).toBeLessThan(html.indexOf('Two'));
    expect(html.indexOf('Two')).toBeLessThan(html.indexOf('Three'));
    expect(html).toContain('overflow-x-auto');
  });

  test('a picture with no thumbnail is a placeholder, never the original', () => {
    const html = renderToStaticMarkup(
      <BriefPictureStrip shown={[{ picture: listed('a.png', false), caption: 'A' }]} />
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('No preview');
  });
});
