import { describe, expect, test } from 'bun:test';
import { viewportBox } from './viewport';

describe('viewportBox', () => {
  test('keyboard closed: the whole screen, nothing inset', () => {
    expect(viewportBox({ height: 844, offsetTop: 0 }, 844)).toEqual({
      height: 844,
      top: 0,
      keyboardInset: 0,
    });
  });

  test('iOS with the keyboard open: the layout viewport keeps its height', () => {
    // 336px of keyboard; Safari has scrolled the page 120px to reveal the field.
    expect(viewportBox({ height: 388, offsetTop: 120 }, 844)).toEqual({
      height: 388,
      top: 120,
      keyboardInset: 336,
    });
  });

  test('Android resizing the content: the layout viewport shrank with it', () => {
    expect(viewportBox({ height: 500, offsetTop: 0 }, 500).keyboardInset).toBe(0);
  });

  test('no visualViewport: the window height, and no inset to guess at', () => {
    expect(viewportBox(null, 700)).toEqual({ height: 700, top: 0, keyboardInset: 0 });
  });

  test('sub-pixel noise never produces a negative inset', () => {
    expect(viewportBox({ height: 844.4, offsetTop: 0 }, 844).keyboardInset).toBe(0);
  });
});
