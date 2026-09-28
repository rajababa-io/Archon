import { describe, expect, test } from 'bun:test';
import { SWIPE_PX, swipeOf } from './gesture';

describe('swipeOf', () => {
  test('reads the four directions', () => {
    expect(swipeOf(80, 5)).toBe('right');
    expect(swipeOf(-80, 5)).toBe('left');
    expect(swipeOf(5, -80)).toBe('up');
    expect(swipeOf(5, 80)).toBe('down');
  });

  test('a short movement is not a swipe', () => {
    expect(swipeOf(SWIPE_PX - 1, 0)).toBeNull();
  });

  test('a diagonal drag is a scroll that wandered, not a swipe', () => {
    expect(swipeOf(80, 70)).toBeNull();
    expect(swipeOf(-70, 80)).toBeNull();
  });
});
