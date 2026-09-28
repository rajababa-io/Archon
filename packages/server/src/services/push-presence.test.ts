import { describe, expect, test } from 'bun:test';
import { ChatPresence } from './push-presence';

describe('ChatPresence', () => {
  test('a report holds for the window and then lapses on its own', () => {
    let now = 0;
    const presence = new ChatPresence(45_000, () => now);
    presence.report('phone', 'web-1');
    now = 44_999;
    expect(presence.isVisible('web-1')).toBe(true);
    now = 45_000;
    expect(presence.isVisible('web-1')).toBe(false);
  });

  test('a client shows one chat: moving on replaces its last report', () => {
    const presence = new ChatPresence(45_000, () => 0);
    presence.report('phone', 'web-1');
    presence.report('phone', 'web-2');
    expect(presence.isVisible('web-1')).toBe(false);
    expect(presence.isVisible('web-2')).toBe(true);
  });

  test('one client hiding does not hide the chat from another', () => {
    const presence = new ChatPresence(45_000, () => 0);
    presence.report('phone', 'web-1');
    presence.report('desk', 'web-1');
    presence.report('phone', null);
    expect(presence.isVisible('web-1')).toBe(true);
    presence.report('desk', null);
    expect(presence.isVisible('web-1')).toBe(false);
  });
});
