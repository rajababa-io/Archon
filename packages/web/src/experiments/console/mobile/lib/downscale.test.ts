import { describe, expect, test } from 'bun:test';
import { MAX_EDGE_PX, fitWithin, isRedrawable, jpegName } from './downscale';

describe('fitWithin', () => {
  test('leaves an image that already fits alone', () => {
    expect(fitWithin(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(fitWithin(MAX_EDGE_PX, 10)).toEqual({ width: MAX_EDGE_PX, height: 10 });
  });

  test('scales a landscape photo by its width and keeps the aspect ratio', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
  });

  test('scales a portrait photo by its height', () => {
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048 });
  });

  test('never draws an edge at zero pixels', () => {
    expect(fitWithin(40_000, 1)).toEqual({ width: 2048, height: 1 });
  });
});

describe('isRedrawable', () => {
  test('stills are redrawn', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic']) {
      expect(isRedrawable({ type })).toBe(true);
    }
  });

  test('an animation, a vector, and anything not an image go as they are', () => {
    for (const type of ['image/gif', 'image/svg+xml', 'application/pdf', 'text/plain', '']) {
      expect(isRedrawable({ type })).toBe(false);
    }
  });
});

describe('jpegName', () => {
  test('swaps the extension for .jpg', () => {
    expect(jpegName('IMG_0042.HEIC')).toBe('IMG_0042.jpg');
    expect(jpegName('shot.final.png')).toBe('shot.final.jpg');
  });

  test('adds one to a name without', () => {
    expect(jpegName('image')).toBe('image.jpg');
    expect(jpegName('.hidden')).toBe('.hidden.jpg');
  });
});
