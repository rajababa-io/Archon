import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MenuCheckItem, MenuItem } from './RowMenu';

const noop = (): void => undefined;

describe('MenuCheckItem', () => {
  // The tick is a graphic; `aria-checked` is where the state is actually
  // written down. A menu that says "Closed" with no role tells a screen reader
  // nothing about whether it holds.
  test('the state is announced, not only drawn', () => {
    expect(
      renderToStaticMarkup(<MenuCheckItem label="Closed" checked onSelect={noop} />)
    ).toContain('role="menuitemcheckbox" aria-checked="true"');
    expect(
      renderToStaticMarkup(<MenuCheckItem label="Closed" checked={false} onSelect={noop} />)
    ).toContain('aria-checked="false"');
  });

  // The whole point of option C over a toggling verb: the row is findable by
  // position because its word never moves.
  test('the label is the same in both states', () => {
    const on = renderToStaticMarkup(<MenuCheckItem label="Archived" checked onSelect={noop} />);
    const off = renderToStaticMarkup(
      <MenuCheckItem label="Archived" checked={false} onSelect={noop} />
    );
    expect(on).toContain('Archived');
    expect(off).toContain('Archived');
    expect(on).not.toContain('Restore');
    expect(off).not.toContain('Archive<');
  });

  // Hidden rather than absent: removing it would shift the label left by the
  // gutter's width, so an unchecked row would not line up with a checked one.
  test('an unchecked row still reserves the tick gutter', () => {
    const off = renderToStaticMarkup(
      <MenuCheckItem label="Closed" checked={false} onSelect={noop} />
    );
    expect(off).toContain('w-[11px]');
    expect(off).toContain('opacity-0');
  });
});

describe('MenuItem', () => {
  test('a plain row carries the same empty gutter, so labels share a left edge', () => {
    const html = renderToStaticMarkup(<MenuItem label="Rename…" onSelect={noop} />);
    expect(html).toContain('role="menuitem"');
    expect(html).toContain('w-[11px]');
    expect(html).toContain('opacity-0');
  });
});
