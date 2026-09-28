/**
 * Where the mobile shell's installable pieces live. One module, because the
 * worker's scope, the manifest's scope and the registration call must all say
 * the same thing: a worker registered for a scope wider than its own directory
 * is refused by the browser, and a manifest scope the worker does not cover
 * opens the installed app outside it.
 */

/** The shell's URL space. Also its start URL and the worker's scope. */
export const SHELL_SCOPE = '/m/';
export const SERVICE_WORKER_PATH = `${SHELL_SCOPE}sw.js`;
export const MANIFEST_PATH = `${SHELL_SCOPE}manifest.webmanifest`;
/** Served from `public/m/icons/`. */
export const ICON_DIR = `${SHELL_SCOPE}icons/`;
