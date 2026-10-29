// The profile photo (packages/backend/profile-photo.ts has the design): made
// here, in the browser, as a centred square JPEG of at most 512px a side.
// Drawing it on a canvas and encoding it anew leaves every EXIF field (GPS
// included) behind, so the web function needs no image library; the server
// still checks what arrives. A HEIC opens only where the browser can decode
// one (Safari); elsewhere decoding fails and the page asks for a JPEG or PNG.
import { api } from './api.ts';
import { sendFiles } from './files.ts';
import type { Problem } from './say.ts';
import type { Me } from './types.ts';

export const PHOTO_SIDE = 512;
export const PHOTO_MAX = 256 * 1024;
// What the picker offers: any image, HEIC named for the iPhone's files.
export const PHOTO_ACCEPT = 'image/*,.heic,.heif';

// Where the page shows the photo: the API's own address, which checks the
// session and redirects to a short-lived signed link. `at` changes with each
// new photo, so a cached old one is never shown for it.
export const photoSrc = (photo: { at: string }) => `/api/me/photo?v=${encodeURIComponent(photo.at)}`;

// The largest centred square of a w by h picture.
export function square(w: number, h: number) {
  const side = Math.min(w, h);
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), side };
}

type Drawable = ImageBitmap | HTMLImageElement;

// A data: URL, never a blob: one, which the CSP's img-src does not allow.
async function viaImage(file: File): Promise<HTMLImageElement> {
  const url = await new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(file);
  });
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

async function decode(file: File): Promise<Drawable | null> {
  try {
    if (typeof createImageBitmap === 'function') return await createImageBitmap(file);
  } catch {
    /* try an <img> instead */
  }
  try {
    return await viaImage(file);
  } catch {
    return null;
  }
}

const size = (d: Drawable) =>
  'naturalWidth' in d ? { w: d.naturalWidth, h: d.naturalHeight } : { w: d.width, h: d.height };

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', quality));
}

// The picked file as the photo the server takes, or a problem to say.
export async function makePhoto(file: File): Promise<{ blob: Blob } | { problem: Problem }> {
  const picture = await decode(file);
  if (!picture) return { problem: { error: 'photo-decode' } };
  const { w, h } = size(picture);
  // Some browsers "decode" what they cannot draw to a picture of no size.
  if (!w || !h) return { problem: { error: 'photo-decode' } };
  const { sx, sy, side } = square(w, h);
  if (side < 128) return { problem: { error: 'photo-small' } };
  const out = Math.min(side, PHOTO_SIDE);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { problem: { error: 'photo-decode' } };
  ctx.drawImage(picture, sx, sy, side, side, 0, 0, out, out);
  if ('close' in picture) picture.close();
  for (const quality of [0.88, 0.75, 0.6]) {
    const blob = await toJpeg(canvas, quality);
    if (blob && blob.size <= PHOTO_MAX) return { blob };
  }
  return { problem: { error: 'photo-too-big' } };
}

// Made, sent to the bucket as an upload, then set as the photo. Returns the
// profile as the API now has it, or a problem.
export async function setPhoto(file: File, tell: (text: string) => void): Promise<{ me: Me } | { problem: Problem }> {
  tell('Making the photo…');
  const made = await makePhoto(file);
  if ('problem' in made) return made;
  const jpeg = new File([made.blob], 'profile-photo.jpg', { type: 'image/jpeg' });
  const out = await sendFiles([jpeg], tell);
  // The upload lines name a file first ("… didn’t finish sending").
  if (out.problem) return { problem: { error: out.problem.error, file: 'The photo' } };
  tell('Saving…');
  const r = await api<Me>('PUT', '/api/me/photo', { upload: out.sent[0].upload, type: 'image/jpeg' });
  if (!r.ok) return { problem: { ...r.data, file: 'The photo' } };
  return { me: r.data };
}

export async function removePhoto(): Promise<{ me: Me } | { problem: Problem }> {
  const r = await api<Me>('DELETE', '/api/me/photo');
  if (!r.ok) return { problem: r.data };
  return { me: r.data };
}
