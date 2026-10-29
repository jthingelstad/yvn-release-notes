/** Images that arrive inside a request body, as base64 with a MIME type:
 * feedback screenshots from the web page and from an assistant (Jamie,
 * 2026-10-28: "Make sure a user or agent submitting feedback can attach a
 * screenshot"), and any later door that takes a picture the same way.
 *
 * `inlineImages` decodes and checks them all before anything is stored: PNG,
 * JPEG or WebP only, the bytes must be what the type says, each within a
 * size cap, and their number within a count. `stripMetadata` then drops
 * what a camera or an editor writes beside the picture (EXIF with its GPS,
 * XMP, IPTC, comments, text chunks, times) without decoding the pixels, so
 * it needs no Sharp and runs in the web function. A browser that can
 * re-encode (canvas) does so first; this is the server's own guarantee.
 *
 * A JPEG keeps its orientation lost with EXIF: screenshots are upright. */
import { imageSize, looksLike } from './media.ts';

export const INLINE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
};
/** Each image at most this many decoded bytes, unless a caller says less:
 * three of them in base64 stay near 3 MiB, so a request body is well inside
 * Lambda's 6 MB payload limit however the platform carries it. */
export const INLINE_IMAGE_BYTES = 768 * 1024;
export interface InlineImage {
  type: string;
  data: Buffer;
  width?: number;
  height?: number;
}
/** Why a set of images was refused, for the caller's own words. */
export type InlineRefusal = 'image-count' | 'image-type' | 'image-data' | 'image-too-big';
export class InlineImageError extends Error {
  readonly reason: InlineRefusal;
  readonly index: number;
  constructor(reason: InlineRefusal, index = -1) {
    super(reason);
    this.reason = reason;
    this.index = index;
  }
}
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** `[{type, data}]` (data base64, no data: prefix) checked and stripped. */
export function inlineImages(
  value: unknown,
  { max, bytes = INLINE_IMAGE_BYTES }: { max: number; bytes?: number }
): InlineImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new InlineImageError('image-count');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new InlineImageError('image-data', index);
    const { type, data } = entry as Record<string, unknown>;
    if (typeof type !== 'string' || !Object.hasOwn(INLINE_TYPES, type)) throw new InlineImageError('image-type', index);
    if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !BASE64.test(data))
      throw new InlineImageError('image-data', index);
    if ((data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) > bytes)
      throw new InlineImageError('image-too-big', index);
    const raw = Buffer.from(data, 'base64');
    if (!looksLike(type, raw)) throw new InlineImageError('image-data', index);
    let clean: Buffer;
    try {
      clean = stripMetadata(type, raw);
    } catch {
      throw new InlineImageError('image-data', index);
    }
    const size = imageSize(clean);
    return { type, data: clean, ...(size ? { width: size[0], height: size[1] } : {}) };
  });
}

/** The image without its metadata. Throws on a file it cannot walk. */
export function stripMetadata(type: string, data: Buffer): Buffer {
  if (type === 'image/jpeg') return stripJpeg(data);
  if (type === 'image/png') return stripPng(data);
  if (type === 'image/webp') return stripWebp(data);
  throw new Error('Unsupported image type');
}

/** Segments kept: everything but APP1 (EXIF, XMP), APP2..APP15 other than
 * APP14 (Adobe colour transform, needed to decode), APP13 (IPTC) and COM.
 * APP0 (JFIF) and APP2's ICC profile are kept so colours stay right. */
function stripJpeg(data: Buffer): Buffer {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('Not a JPEG');
  const parts: Buffer[] = [data.subarray(0, 2)];
  let i = 2;
  for (;;) {
    if (i + 2 > data.length || data[i] !== 0xff) throw new Error('Broken JPEG');
    const marker = data[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd9) {
      // The end: anything after it is dropped.
      parts.push(data.subarray(i, i + 2));
      break;
    }
    if (i + 4 > data.length) throw new Error('Broken JPEG');
    const length = data.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > data.length) throw new Error('Broken JPEG');
    const segment = data.subarray(i, i + 2 + length);
    if (marker === 0xda) {
      // Start of scan: its entropy-coded data runs to the next marker that
      // is not a stuffed 0x00, a restart (RST0-7) or fill. A progressive
      // file has more segments and scans after it, so the walk goes on
      // and drops metadata there too; nothing after the end marker is kept.
      let j = i + 2 + length;
      while (j < data.length) {
        if (data[j] !== 0xff) {
          j += 1;
          continue;
        }
        const next = data[j + 1];
        if (next === undefined) break;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) j += 2;
        else if (next === 0xff) j += 1;
        else break;
      }
      if (j + 1 >= data.length) throw new Error('Broken JPEG');
      parts.push(data.subarray(i, j));
      i = j;
      continue;
    }
    const icc = marker === 0xe2 && segment.toString('latin1', 4, 15) === 'ICC_PROFILE';
    const drop = marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xee && !icc);
    if (!drop) parts.push(segment);
    i += 2 + length;
  }
  return Buffer.concat(parts);
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
function stripPng(data: Buffer): Buffer {
  const parts: Buffer[] = [data.subarray(0, 8)];
  let i = 8,
    ended = false;
  while (!ended) {
    if (i + 12 > data.length) throw new Error('Broken PNG');
    const length = data.readUInt32BE(i),
      name = data.toString('latin1', i + 4, i + 8),
      end = i + 12 + length;
    if (end > data.length) throw new Error('Broken PNG');
    if (!PNG_DROP.has(name)) parts.push(data.subarray(i, end));
    ended = name === 'IEND';
    i = end;
  }
  return Buffer.concat(parts);
}

const WEBP_DROP = new Set(['EXIF', 'XMP ']);
function stripWebp(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  // Only the chunks inside the RIFF size: bytes after it are dropped.
  const limit = Math.min(data.length, 8 + data.readUInt32LE(4));
  let i = 12;
  while (i < limit) {
    if (i + 8 > limit) throw new Error('Broken WebP');
    const name = data.toString('latin1', i, i + 4),
      length = data.readUInt32LE(i + 4),
      end = i + 8 + length + (length % 2);
    if (i + 8 + length > limit) throw new Error('Broken WebP');
    if (!WEBP_DROP.has(name)) {
      const chunk = Buffer.from(data.subarray(i, Math.min(end, limit)));
      // VP8X flags: clear EXIF (bit 3) and XMP (bit 2) now that they are gone.
      if (name === 'VP8X' && chunk.length > 8) chunk[8] = chunk[8]! & ~0x0c;
      chunks.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(chunks),
    head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
