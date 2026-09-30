import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PushDevice } from '../../skills';
import { PushDeviceRows } from './NotifyControls';

const NOW = Date.parse('2026-09-30T12:00:00Z');

// Two browsers that read alike: only the id tells them apart.
const DEVICES: PushDevice[] = [
  {
    id: 'old',
    label: 'iPhone · Home Screen app',
    created_at: '2026-09-28 12:00:00',
    last_success_at: null,
  },
  {
    id: 'new',
    label: 'iPhone · Home Screen app',
    created_at: '2026-09-30T10:00:00.000Z',
    last_success_at: '2026-09-30T11:00:00.000Z',
  },
];

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every button in a rendered tree, found by walking the elements rather than a DOM. */
function buttons(node: ReactNode): ReactElement<{ onClick: () => void; 'aria-label': string }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const own =
    node.type === 'button'
      ? [node as ReactElement<{ onClick: () => void; 'aria-label': string }>]
      : [];
  return [...own, ...buttons(node.props.children)];
}

describe('PushDeviceRows', () => {
  test('each device shows its label, when it was added and when a push last got through', () => {
    const html = renderToStaticMarkup(
      <PushDeviceRows
        devices={DEVICES}
        thisDeviceId="new"
        removing={null}
        onRemove={() => undefined}
        now={NOW}
      />
    );
    expect(text(html)).toBe(
      'iPhone · Home Screen app Added 2d ago · no push has got through yet Remove ' +
        'iPhone · Home Screen app · this device Added 2h ago · last push 1h ago Remove'
    );
  });

  test('Remove names the row by id, so a look-alike is never the one removed', () => {
    const removed: string[] = [];
    const tree = PushDeviceRows({
      devices: DEVICES,
      thisDeviceId: 'new',
      removing: null,
      onRemove: id => removed.push(id),
      now: NOW,
    });
    const [first, second] = buttons(tree);
    first?.props.onClick();
    expect(removed).toEqual(['old']);
    second?.props.onClick();
    expect(removed).toEqual(['old', 'new']);
    expect(second?.props['aria-label']).toBe('Remove iPhone · Home Screen app (this device)');
  });

  test('while one is being removed, every Remove waits', () => {
    const html = renderToStaticMarkup(
      <PushDeviceRows
        devices={DEVICES}
        thisDeviceId={null}
        removing="old"
        onRemove={() => undefined}
        now={NOW}
      />
    );
    expect(text(html)).toContain('Removing…');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain('this device');
  });

  test('with nothing registered it says so', () => {
    const html = renderToStaticMarkup(
      <PushDeviceRows devices={[]} thisDeviceId={null} removing={null} onRemove={() => undefined} />
    );
    expect(text(html)).toBe('No device has push on.');
  });
});
