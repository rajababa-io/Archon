import { describe, expect, test } from 'bun:test';
import { isNewChatKey } from './new-chat-key';

const press = (
  key: string,
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}
): boolean =>
  isNewChatKey({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

describe('isNewChatKey', () => {
  test('⌘⇧O and Ctrl+Shift+O start a new chat, whatever case Shift produces', () => {
    expect(press('O', { metaKey: true, shiftKey: true })).toBe(true);
    expect(press('o', { metaKey: true, shiftKey: true })).toBe(true);
    expect(press('O', { ctrlKey: true, shiftKey: true })).toBe(true);
  });

  test('without Shift it is the browser’s ⌘O, not ours', () => {
    expect(press('o', { metaKey: true })).toBe(false);
  });

  test('a bare letter never fires — the composer types it', () => {
    expect(press('o')).toBe(false);
    expect(press('O', { shiftKey: true })).toBe(false);
  });

  test('Alt added is a different chord', () => {
    expect(press('O', { metaKey: true, shiftKey: true, altKey: true })).toBe(false);
  });
});
