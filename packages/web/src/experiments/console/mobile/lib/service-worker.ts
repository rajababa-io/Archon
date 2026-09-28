import { SERVICE_WORKER_PATH, SHELL_SCOPE } from '../pwa/paths';

/**
 * Register the shell's worker. Production builds only: the dev server has no
 * bundle and so no `/m/sw.js` (see `pwa/vite-plugin.ts`).
 *
 * A failed registration is reported and otherwise ignored: the worker only
 * makes the next launch faster, and the shell works the same without it.
 */
export function registerShellWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register(SERVICE_WORKER_PATH, { scope: SHELL_SCOPE })
    .catch((e: unknown) => {
      console.warn('[mobile] service worker registration failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    });
}
