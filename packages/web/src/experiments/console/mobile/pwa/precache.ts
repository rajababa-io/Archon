/**
 * Which built files make up the app shell the mobile service worker precaches.
 *
 * The entry chunk and everything it imports statically, with their CSS: what
 * the first paint needs. Lazy chunks (the file viewer, the editor) stay out —
 * they load on demand, and precaching them would make every install download
 * code most sessions never run.
 */

/** The parts of Rollup's output bundle this reads. */
export type BundleItem =
  | {
      type: 'chunk';
      fileName: string;
      isEntry: boolean;
      imports: readonly string[];
      viteMetadata?: { importedCss: ReadonlySet<string> };
    }
  | { type: 'asset'; fileName: string };

/** Root-relative URLs of the shell's files, sorted so the list is stable per build. */
export function shellFiles(bundle: Readonly<Record<string, BundleItem>>): string[] {
  const out = new Set<string>();
  const visit = (fileName: string): void => {
    const item = bundle[fileName];
    if (item?.type !== 'chunk' || out.has(`/${fileName}`)) return;
    out.add(`/${fileName}`);
    for (const css of item.viteMetadata?.importedCss ?? []) out.add(`/${css}`);
    for (const dep of item.imports) visit(dep);
  };
  for (const item of Object.values(bundle)) {
    if (item.type === 'chunk' && item.isEntry) visit(item.fileName);
  }
  return [...out].sort();
}
