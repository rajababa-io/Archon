import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefText } from './ProjectBriefCard';

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
