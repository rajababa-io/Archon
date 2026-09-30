import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachedFiles, AttachedFilesView } from './AttachedFiles';

const noop = (): void => undefined;
const file = (name: string): File => new File(['x'], name, { type: 'text/plain' });

describe('AttachedFiles', () => {
  // Mounted unconditionally by both callers, so an empty list has to be
  // nothing at all rather than an empty box holding open a gap.
  test('renders nothing with no files and no error', () => {
    expect(renderToStaticMarkup(<AttachedFiles files={[]} error={null} onRemove={noop} />)).toBe(
      ''
    );
  });

  test('each file is named, sized and individually removable', () => {
    const html = renderToStaticMarkup(
      <AttachedFiles files={[file('a.md'), file('b.png')]} error={null} onRemove={noop} />
    );
    expect(html).toContain('a.md');
    expect(html).toContain('b.png');
    expect(html).toContain('aria-label="Remove a.md"');
    expect(html).toContain('aria-label="Remove b.png"');
  });

  test('a refusal shows even when nothing was kept', () => {
    const html = renderToStaticMarkup(
      <AttachedFiles
        files={[]}
        error="Skipped 1 file(s) — huge.png: larger than 10 MB"
        onRemove={noop}
      />
    );
    expect(html).toContain('larger than 10 MB');
  });

  // The object URLs exist only in a browser, so the view is fed them directly.
  test('an image with a preview shows its picture; other files stay name and size', () => {
    const html = renderToStaticMarkup(
      <AttachedFilesView
        files={[file('shot.png'), file('notes.md')]}
        previews={['blob:shot', null]}
        error={null}
        onRemove={noop}
      />
    );
    expect(html).toContain('src="blob:shot"');
    expect(html).toContain('alt="shot.png"');
    expect(html.match(/<img/g)?.length).toBe(1);
    expect(html).toContain('notes.md');
  });
});
