/**
 * The favicon with a small working-blue dot on it, while any chat works.
 *
 * On the favicon rather than in the title because the title is plain text: it
 * cannot take a colour, and a text dot is drawn as large as the letters. The
 * icon is the one place in the tab strip the console can paint.
 *
 * The colour is the theme's own `--running`, read off the console root at draw
 * time, so it is the same blue as the rail's working dot under any theme.
 */
import { useEffect } from 'react';

/** Dot diameter as a fraction of the icon. Small enough to leave the logo readable. */
const DOT = 0.4;

export function useFaviconBadge(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link === null) return;
    const original = link.href;
    let cancelled = false;
    const img = new Image();
    img.onload = (): void => {
      if (cancelled) return;
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      const blue = runningColor();
      // No theme colour means no console root on the page; a guessed blue would
      // be a second copy of the token, so the plain icon stays instead.
      if (blue === '') return;
      ctx.drawImage(img, 0, 0, size, size);
      const r = (size * DOT) / 2;
      const cx = size - r - 1;
      const cy = size - r - 1;
      // A dark ring first, so the dot stays a dot on light and dark tab strips.
      ctx.beginPath();
      ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = blue;
      ctx.fill();
      link.href = canvas.toDataURL('image/png');
    };
    // An icon that fails to load leaves the plain favicon: the dot is a nicety,
    // and the title count still carries what needs you.
    img.src = original;
    return (): void => {
      cancelled = true;
      link.href = original;
    };
  }, [on]);
}

function runningColor(): string {
  const root = document.querySelector('.console-root');
  return root === null ? '' : getComputedStyle(root).getPropertyValue('--running').trim();
}
