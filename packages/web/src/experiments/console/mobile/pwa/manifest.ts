import { DARK_PRESET, presetById } from '../../../../theme/presets';
import { ICON_DIR, SHELL_SCOPE } from './paths';

/**
 * The installed app's colour before any page has painted: the splash screen
 * and the status bar on launch. The dark preset, which is also the console's
 * own default. Once the shell runs, it sets the live `theme-color` from the
 * theme actually chosen.
 */
export const LAUNCH_COLOR = presetById(DARK_PRESET)?.background ?? '#090A0C';

/** The web app manifest, served at `MANIFEST_PATH`. */
export function webManifest(): Record<string, unknown> {
  return {
    id: SHELL_SCOPE,
    name: 'Archon',
    short_name: 'Archon',
    start_url: SHELL_SCOPE,
    scope: SHELL_SCOPE,
    display: 'standalone',
    theme_color: LAUNCH_COLOR,
    background_color: LAUNCH_COLOR,
    icons: [
      { src: `${ICON_DIR}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${ICON_DIR}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: `${ICON_DIR}maskable-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
