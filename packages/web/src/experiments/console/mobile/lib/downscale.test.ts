import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_EDGE_PX, downscaleImage, fitWithin, isRedrawable, jpegName } from './downscale';

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

describe('downscaleImage', () => {
  const saved = { createImageBitmap: globalThis.createImageBitmap, document: globalThis.document };
  afterEach(() => {
    globalThis.createImageBitmap = saved.createImageBitmap;
    globalThis.document = saved.document;
  });

  test('a canvas that fails mid-redraw hands back the original instead of rejecting', async () => {
    let closed = false;
    const bitmap = { width: 4032, height: 3024, close: () => (closed = true) };
    globalThis.createImageBitmap = (() =>
      Promise.resolve(bitmap)) as unknown as typeof createImageBitmap;
    globalThis.document = {
      createElement: () => {
        throw new Error('out of memory');
      },
    } as unknown as Document;
    const photo = new File([new Uint8Array(8)], 'IMG_0042.png', { type: 'image/png' });
    expect(await downscaleImage(photo)).toBe(photo);
    expect(closed).toBe(true);
  });
});
