// Screenshots for feedback, made ready in the browser before they are sent:
// decoded (a HEIC too, where the browser can open one), drawn again on a
// canvas, which leaves every EXIF, GPS and other metadata block behind, scaled
// to at most MAX_SIDE and kept under the server's byte cap, as a PNG when one
// fits and a JPEG otherwise. The server strips metadata again
// (packages/backend/inline-images.ts) and checks the cap itself; this is so a
// phone's 4 MB screenshot is still accepted.

export const MAX_SIDE = 2400;
export interface Ready {
  type: 'image/png' | 'image/jpeg';
  data: string; // base64, no data: prefix
  preview: string; // a data: URL, for the form's thumbnail
  width: number;
  height: number;
}
export type Refusal = 'open' | 'too-big';

/** The scale that brings the longer side to at most `max`. */
export const fit = (width: number, height: number, max = MAX_SIDE) => Math.min(1, max / Math.max(width, height));

// Each attempt: a type, a JPEG quality and a further scale.
const ATTEMPTS: [Ready['type'], number, number][] = [
  ['image/png', 1, 1],
  ['image/jpeg', 0.88, 1],
  ['image/jpeg', 0.8, 0.75],
  ['image/jpeg', 0.75, 0.5],
  ['image/jpeg', 0.7, 0.35]
];

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let text = '';
  for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(text);
}

export async function prepare(file: File, maxBytes: number): Promise<Ready | Refusal> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return 'open';
  }
  try {
    const base = fit(bitmap.width, bitmap.height);
    for (const [type, quality, more] of ATTEMPTS) {
      const width = Math.max(1, Math.round(bitmap.width * base * more)),
        height = Math.max(1, Math.round(bitmap.height * base * more)),
        canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return 'open';
      if (type === 'image/jpeg') {
        context.fillStyle = '#fff';
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, type, quality));
      if (!blob || blob.type !== type || blob.size > maxBytes) continue;
      const data = base64(await blob.arrayBuffer());
      return { type, data, preview: `data:${type};base64,${data}`, width, height };
    }
    return 'too-big';
  } finally {
    bitmap.close();
  }
}
