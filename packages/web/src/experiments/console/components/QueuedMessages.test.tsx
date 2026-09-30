import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueuedMessages } from './QueuedMessages';
import type { QueuedMessage } from '../skills/conversations';

const noop = (): void => undefined;
const queued = (over: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: 'q-1',
  text: 'also check the tests',
  files: [],
  queuedAt: '2026-09-27T00:00:00.000Z',
  steering: false,
  ...over,
});

function render(messages: QueuedMessage[], steerable: boolean): string {
  return renderToStaticMarkup(
    <QueuedMessages
      messages={messages}
      busyIds={new Set()}
      onEdit={noop}
      onRemove={noop}
      steerable={steerable}
      onSteer={noop}
    />
  );
}

describe('QueuedMessages — send now', () => {
  test('offers Send now while the running turn can read it', () => {
    expect(render([queued()], true)).toContain('Send now');
  });

  test('never offers it when the provider cannot take a message mid-turn', () => {
    const html = render([queued()], false);
    expect(html).not.toContain('Send now');
    expect(html).toContain('Edit');
  });

  test('a message with attachments waits for its own turn', () => {
    const files = [{ name: 'a.png', mimeType: 'image/png', size: 1, imageUrl: null }];
    expect(render([queued({ files })], true)).not.toContain('Send now');
  });

  test('once sent into the turn it says so and cannot be edited or removed', () => {
    const html = render([queued({ steering: true })], true);
    expect(html).toContain('Sent into this turn');
    expect(html).not.toContain('Send now');
    expect(html).not.toContain('Edit');
    expect(html).not.toContain('Remove');
  });
});
