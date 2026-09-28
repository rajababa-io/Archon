/**
 * What the document head says while the mobile shell is mounted.
 *
 * Added on mount and removed on unmount rather than written into index.html,
 * because that file is the desktop console's too: the manifest would offer to
 * install the desktop console, and `interactive-widget` would change how a
 * narrow desktop window handles its keyboard. The desktop console never sees
 * any of this.
 */
import { useEffect } from 'react';
import { resolveTheme, useAppearance, useResolvedMode } from '@/theme/appearance';
import { ICON_DIR, MANIFEST_PATH } from '../pwa/paths';

/**
 * `viewport-fit=cover` lets the shell paint under the notch, which the header
 * pads back out with `safe-area-inset-top`. `interactive-widget` is Android's
 * half of the keyboard-safe layout; see `viewport.ts`.
 */
const MOBILE_VIEWPORT =
  'width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content';

function addToHead(tag: 'link' | 'meta', attrs: Record<string, string>): HTMLElement {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  document.head.appendChild(el);
  return el;
}

export function useMobileHead(): void {
  useEffect(() => {
    const added = [
      addToHead('link', { rel: 'manifest', href: MANIFEST_PATH }),
      addToHead('link', { rel: 'apple-touch-icon', href: `${ICON_DIR}apple-touch-icon.png` }),
      addToHead('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }),
      addToHead('meta', { name: 'apple-mobile-web-app-title', content: 'Archon' }),
      addToHead('meta', {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'black-translucent',
      }),
    ];
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const desktopViewport = viewport?.content;
    if (viewport !== null) viewport.content = MOBILE_VIEWPORT;
    return (): void => {
      for (const el of added) el.remove();
      if (viewport !== null && desktopViewport !== undefined) viewport.content = desktopViewport;
    };
  }, []);

  // The browser chrome takes the colour of the theme actually on screen.
  const appearance = useAppearance();
  const mode = useResolvedMode();
  const background = resolveTheme(appearance, mode === 'dark').input.background;
  useEffect(() => {
    const meta = addToHead('meta', { name: 'theme-color', content: background });
    return (): void => {
      meta.remove();
    };
  }, [background]);
}
