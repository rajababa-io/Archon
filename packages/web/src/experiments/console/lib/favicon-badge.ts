/**
 * The favicon with a count badge on it, drawn the way Gmail draws unread mail:
 * a white rounded tag in the bottom-right corner with the number in dark bold.
 *
 * On the favicon because the icon is the part of a tab that survives a crowded
 * tab strip; the title text is the first thing a narrow tab cuts off.
 */
import { useEffect } from 'react';

/** Canvas size. Drawn large and scaled down by the browser, so edges stay crisp. */
const SIZE = 64;
/**
 * Badge height as a fraction of the icon. Gmail's tag covers about two-thirds,
 * and at 16px anything smaller leaves a number too small to read.
 */
const BADGE_H = 0.7;
/** Glyph size as a fraction of the tag: the number fills it, as Gmail's does. */
const GLYPH = 0.92;

/** `text` is what the badge says; empty means the plain icon. */
export function useFaviconBadge(text: string): void {
  useEffect(() => {
    if (text === '') return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link === null) return;
    const original = link.href;
    let cancelled = false;
    const img = new Image();
    img.onload = (): void => {
      if (cancelled) return;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      ctx.drawImage(img, 0, 0, SIZE, SIZE);

      const h = Math.round(SIZE * BADGE_H);
      ctx.font = `bold ${String(Math.round(h * GLYPH))}px Arial, Helvetica, sans-serif`;
      const w = Math.min(SIZE, Math.max(h * 0.8, ctx.measureText(text).width + h * 0.24));
      const x = SIZE - w;
      const y = SIZE - h;

      // A dark outline under the white tag, so it separates from the logo and
      // from a light tab strip alike.
      ctx.beginPath();
      ctx.roundRect(x - 2, y - 2, w + 2, h + 2, h * 0.3);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, h * 0.26);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      ctx.fillStyle = '#202124';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + w / 2, y + h / 2 + h * 0.05);
      link.href = canvas.toDataURL('image/png');
    };
    // An icon that fails to load leaves the plain favicon; the title still
    // carries the count.
    img.src = original;
    return (): void => {
      cancelled = true;
      link.href = original;
    };
  }, [text]);
}
