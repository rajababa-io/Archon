/**
 * Photos are shrunk on the phone before they are uploaded: a camera frame is
 * 4–8k pixels on its long edge and several megabytes, which is slow over a
 * phone's uplink, often over the server's 10 MB per-file limit, and far more
 * than an agent reading the image needs.
 */

/** The long edge a photo is shrunk to. */
export const MAX_EDGE_PX = 2048;
/** JPEG quality for the re-encode, as `toBlob` takes it. */
export const JPEG_QUALITY = 0.85;

/** The size an image is drawn at: its own, or scaled so the long edge is `maxEdge`. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE_PX
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height };
  const scale = maxEdge / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Whether a file is a still raster image a canvas can redraw. A GIF would lose
 * its animation and an SVG is not pixels, so both go as they are.
 */
export function isRedrawable(file: Pick<File, 'type'>): boolean {
  const mime = (file.type.split(';')[0] ?? '').trim().toLowerCase();
  return mime.startsWith('image/') && mime !== 'image/gif' && mime !== 'image/svg+xml';
}

/** `IMG_0042.HEIC` → `IMG_0042.jpg`: the name follows the bytes. */
export function jpegName(name: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.jpg`;
}

async function encode(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => {
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
  });
}

/**
 * The file to upload for one picked or pasted image: redrawn at most
 * MAX_EDGE_PX on its long edge and re-encoded as JPEG, or the original when
 * that would not make it smaller.
 *
 * A file the browser cannot decode (HEIC outside Safari, a corrupt picture) is
 * returned unchanged, deliberately: the attachment tray shows it with its real
 * size, and the server stays the authority that accepts or refuses it.
 */
export async function downscaleImage(file: File): Promise<File> {
  if (!isRedrawable(file)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height);
    const resized = size.width !== bitmap.width || size.height !== bitmap.height;
    if (!resized && file.type === 'image/jpeg') return file;
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (context === null) return file;
    // JPEG has no transparency: a screenshot's clear pixels would turn black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await encode(canvas);
    if (blob === null || (!resized && blob.size >= file.size)) return file;
    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}
