import { useEffect, useState } from 'react';

/**
 * A preview URL per file, index-aligned: an object URL for an image, `null`
 * for anything else. Shared by the phone's attachment tray and the console's
 * attachment chips, so an image looks the same before send on both.
 *
 * Created and revoked in one effect, so every URL made is released — creating
 * them during render would leak one per extra render. The cost is one render
 * with no previews, which is also what a server render sees.
 *
 * The URLs are kept with the list they were made for and returned only while
 * that list is current. Otherwise, in the render after a removal, the old
 * array would shift every later file onto its neighbour's picture.
 */
export function useImagePreviews(files: readonly File[]): readonly (string | null)[] {
  const [made, setMade] = useState<{
    files: readonly File[];
    urls: readonly (string | null)[];
  } | null>(null);
  useEffect(() => {
    const urls = files.map(f => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null));
    setMade({ files, urls });
    return (): void => {
      for (const url of urls) if (url !== null) URL.revokeObjectURL(url);
    };
  }, [files]);
  return made?.files === files ? made.urls : [];
}
