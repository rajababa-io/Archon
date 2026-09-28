import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { shellFiles } from './precache';
import { webManifest } from './manifest';
import {
  MANIFEST_PATH,
  NOTIFICATION_ICON,
  OPEN_PATH_MESSAGE,
  SERVICE_WORKER_PATH,
  SHELL_SCOPE,
} from './paths';

/** An emitted file's name is relative to the output directory. */
const outFile = (path: string): string => path.replace(/^\//, '');

/** The worker template with this build's shell files and a version hashed from them. */
export function serviceWorkerSource(files: readonly string[]): string {
  const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16);
  const template = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8');
  return template
    .replace('__SHELL_VERSION__', JSON.stringify(version))
    .replace('__SHELL_URL__', JSON.stringify(SHELL_SCOPE))
    .replace('__SHELL_FILES__', JSON.stringify(files))
    .replace('__NOTIFICATION_ICON__', JSON.stringify(NOTIFICATION_ICON))
    .replace('__OPEN_PATH_MESSAGE__', JSON.stringify(OPEN_PATH_MESSAGE));
}

/**
 * Emit the mobile shell's web app manifest, and its service worker from the
 * template, carrying the list of files this build's shell is made of. Build
 * only: the dev server serves modules, not a bundle, so there is nothing to
 * precache and the shell does not register a worker there.
 */
export function mobilePwa(): Plugin {
  return {
    name: 'archon-mobile-pwa',
    apply: 'build',
    generateBundle(_options, bundle): void {
      const files = shellFiles(bundle);
      this.emitFile({
        type: 'asset',
        fileName: outFile(SERVICE_WORKER_PATH),
        source: serviceWorkerSource(files),
      });
      this.emitFile({
        type: 'asset',
        fileName: outFile(MANIFEST_PATH),
        source: JSON.stringify(webManifest(), null, 2),
      });
    },
  };
}
