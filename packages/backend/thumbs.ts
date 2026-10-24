/** Thumbnails run only in the describe stream worker. Originals stay intact;
 * only colour metadata survives in the small inline-email JPEG. */
import sharp from 'sharp';
import { read as exif } from './exif.ts';
import { thumbKey } from './media.ts';
import { object, rounded } from './places.ts';
import { missing, type Objects } from './services.ts';
import type { Store } from './store.ts';
import type { NoteRecord } from '../domain/notes.ts';
export { thumbKey } from './media.ts';
export const LONGEST = 640,
  TARGET = 80 * 1024,
  SMALLEST = 240,
  MAX_PIXELS = 100_000_000;
export const FORMATS = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// Photos whose time and place are read (exif.ts): a JPEG, or an iPhone's HEIC.
export const EXIF = new Set(['image/jpeg', 'image/heic', 'image/heif']);
export const QUALITIES = [80, 72, 64, 56];
export interface Thumbnail {
  body: Buffer;
  width: number;
  height: number;
}
export type Maker = (data: Buffer) => Promise<Thumbnail | null>;
/** Photos not yet seen by this worker: those it can make a thumbnail of,
 * and HEICs, read only for their time and place. */
export function waiting(note: NoteRecord) {
  return (note.media ?? []).filter(
    (m) =>
      m.kind === 'image' &&
      (FORMATS.has(String(m.type)) || EXIF.has(String(m.type))) &&
      !('thumb' in m) &&
      String(m.key ?? '').startsWith('media/')
  );
}
export function counts(notes: readonly NoteRecord[]) {
  const out = { notes: 0, photos: 0, bytes: 0, left: {} as Record<string, number> };
  for (const note of notes) {
    // Thumbnails still to make; a HEIC (read only for metadata) is `left`.
    const todo = waiting(note).filter((m) => FORMATS.has(String(m.type)));
    out.notes += Number(todo.length > 0);
    out.photos += todo.length;
    out.bytes += todo.reduce((sum, m) => sum + Number(m.size || 0), 0);
    for (const m of note.media ?? [])
      if (m.kind === 'image' && !FORMATS.has(String(m.type)) && !('thumb' in m)) {
        const type = String(m.type ?? '');
        out.left[type] = (out.left[type] ?? 0) + 1;
      }
  }
  return out;
}
export const make: Maker = async (data) => {
  try {
    const source = sharp(data, { limitInputPixels: MAX_PIXELS, failOn: 'warning', pages: 1, sequentialRead: true }),
      metadata = await source.metadata();
    if (!metadata.width || !metadata.height || !['jpeg', 'png', 'gif', 'webp'].includes(metadata.format ?? ''))
      return null;
    let longest = LONGEST;
    while (true) {
      for (const quality of QUALITIES) {
        const { data: body, info } = await source
          .clone()
          .autoOrient()
          .resize({ width: longest, height: longest, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: { r: 255, g: 251, b: 242 } })
          .keepIccProfile()
          .jpeg({ quality, progressive: true, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        if (body.length <= TARGET) return { body, width: info.width, height: info.height };
      }
      if (longest * 0.8 < SMALLEST) return null;
      longest = rounded(longest * 0.8);
    }
  } catch {
    return null;
  }
};
export async function thumbnail(
  note: NoteRecord,
  user: string,
  store: Pick<Store, 'setMediaField'>,
  objects: Objects,
  maker: Maker = make
): Promise<number> {
  const [, day, id] = String(note.sk).split('#');
  if (!day || !id) throw new Error('Invalid note key');
  let done = 0;
  for (const m of waiting(note)) {
    let data: Buffer | null = null;
    try {
      data = (await objects.get(String(m.key))).body;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (data && EXIF.has(String(m.type)) && (!('taken_at' in m) || !('place' in m))) {
      const found = exif(data);
      if (found.taken_at && !('taken_at' in m))
        await store.setMediaField(user, day, id, Number(m.n), 'taken_at', found.taken_at);
      if (found.lat !== undefined && !('place' in m))
        await store.setMediaField(user, day, id, Number(m.n), 'place', { lat: found.lat, lon: found.lon });
    }
    // A HEIC is read for its time and place, but no thumbnail is made of it.
    const made = data && FORMATS.has(String(m.type)) ? await maker(data) : null;
    let entry: Record<string, unknown> = {};
    if (made) {
      const key = thumbKey(String(m.key));
      await objects.put(key, made.body, { type: 'image/jpeg', disposition: 'inline' });
      entry = { key, size: made.body.length, width: made.width, height: made.height };
    }
    if (!(await store.setMediaField(user, day, id, Number(m.n), 'thumb', entry))) {
      if (entry.key) await objects.remove(String(entry.key));
      break;
    }
    done += Number(Object.keys(entry).length > 0);
  }
  return done;
}
export function entry(media: Record<string, unknown>) {
  return object(media.thumb);
}
