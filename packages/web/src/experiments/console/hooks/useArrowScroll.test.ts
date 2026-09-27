import { describe, test, expect } from 'bun:test';
import { arrowScrollDelta, ARROW_SCROLL_PX, type FocusedElement } from './useArrowScroll';

function press(key: string, over: Partial<Parameters<typeof arrowScrollDelta>[0]> = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...over,
  };
}

const composer: FocusedElement = { tagName: 'TEXTAREA', isContentEditable: false };

describe('arrowScrollDelta', () => {
  test('arrows scroll when nothing holds focus', () => {
    expect(arrowScrollDelta(press('ArrowDown'), null)).toBe(ARROW_SCROLL_PX);
    expect(arrowScrollDelta(press('ArrowUp'), null)).toBe(-ARROW_SCROLL_PX);
  });

  test('plain arrows in the composer belong to its history, even when empty', () => {
    expect(arrowScrollDelta(press('ArrowUp'), composer)).toBe(null);
    expect(arrowScrollDelta(press('ArrowDown'), composer)).toBe(null);
  });

  test('Option-arrows scroll from inside the composer', () => {
    expect(arrowScrollDelta(press('ArrowUp', { altKey: true }), composer)).toBe(-ARROW_SCROLL_PX);
    expect(arrowScrollDelta(press('ArrowDown', { altKey: true }), composer)).toBe(ARROW_SCROLL_PX);
    expect(arrowScrollDelta(press('ArrowDown', { altKey: true }), null)).toBe(ARROW_SCROLL_PX);
  });

  test('selects and rich editors keep even the Option form', () => {
    const select = { tagName: 'SELECT', isContentEditable: false };
    expect(arrowScrollDelta(press('ArrowDown', { altKey: true }), select)).toBe(null);
    const editor = { tagName: 'DIV', isContentEditable: true };
    expect(arrowScrollDelta(press('ArrowDown', { altKey: true }), editor)).toBe(null);
  });

  test('single-line inputs and rich editors keep the key', () => {
    expect(arrowScrollDelta(press('ArrowUp'), { tagName: 'INPUT', isContentEditable: false })).toBe(
      null
    );
    expect(
      arrowScrollDelta(press('ArrowUp'), { tagName: 'SELECT', isContentEditable: false })
    ).toBe(null);
    expect(arrowScrollDelta(press('ArrowUp'), { tagName: 'DIV', isContentEditable: true })).toBe(
      null
    );
  });

  test('a focusable card inside the transcript still scrolls', () => {
    expect(arrowScrollDelta(press('ArrowDown'), { tagName: 'DIV', isContentEditable: false })).toBe(
      ARROW_SCROLL_PX
    );
  });

  test('ignores other keys, modifier combos and keys already handled', () => {
    expect(arrowScrollDelta(press('ArrowLeft'), null)).toBe(null);
    expect(arrowScrollDelta(press('j'), null)).toBe(null);
    expect(arrowScrollDelta(press('ArrowDown', { metaKey: true }), null)).toBe(null);
    expect(arrowScrollDelta(press('ArrowDown', { shiftKey: true }), null)).toBe(null);
    expect(arrowScrollDelta(press('ArrowDown', { defaultPrevented: true }), null)).toBe(null);
  });

  test('honours a caller-supplied step', () => {
    expect(arrowScrollDelta(press('ArrowDown'), null, 10)).toBe(10);
    expect(arrowScrollDelta(press('ArrowUp'), null, 10)).toBe(-10);
  });
});
