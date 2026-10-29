/** Private media from all channels. Checked uploads are copied by immutable
 * S3 version into a key no upload form can overwrite. Raw mail stays whole. */
import type { NoteRecord } from '../domain/notes.ts';
import type { Objects } from './services.ts';
import { object } from './places.ts';
import { codePointSlice, pythonTrim } from '../domain/unicode.ts';
export const IMAGES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif'
};
export const AUDIO: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac'
};
export const PDF: Record<string, string> = { 'application/pdf': 'pdf' };
export const UPLOADABLE = { ...IMAGES, ...AUDIO, ...PDF };
const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-aac': 'audio/aac',
  'audio/x-flac': 'audio/flac',
  'application/x-pdf': 'application/pdf'
};
const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  m4a: 'audio/mp4',
  mp4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf'
};
export const MIN_SIDE = 200,
  MIN_UNREAD = 20 * 1024,
  MIN_AUDIO = 1024,
  MAX_FILES = 20,
  MAX_UPLOAD = 50 * 1024 * 1024,
  HEAD = 64 * 1024;
export type MediaKind = 'image' | 'audio' | 'file';
export interface MediaEntry extends Record<string, unknown> {
  n: number;
  kind: MediaKind;
  type: string;
  size: number;
  key: string;
}
export interface Attachment {
  content_type: string;
  filename: string;
  size: number;
  refused?: boolean;
}
export interface MediaPart {
  type: string;
  filename: string;
  data: Buffer;
}
/** A file's name as the web keeps it: the last part of a path, without
 * control or odd space characters, at most 120 code points. */
export const fileName = (value: unknown): string =>
  typeof value === 'string'
    ? codePointSlice(
        pythonTrim(
          value
            .split(/[\\/]/)
            .at(-1)!
            .replace(/[\p{C}\p{Z}]/gu, (c) => (c === ' ' ? ' ' : ''))
        ),
        0,
        120
      )
    : '';
/** The type an emailed part is kept as, or null for one kept only in the raw
 * mail: photos, recordings and PDFs (Jamie, 2026-10-29: "Yes we should keep
 * pdf on the note."), as the web takes them. */
export function mediaType(contentType: string, filename: string): string | null {
  const raw = contentType.toLowerCase(),
    type = ALIASES[raw] || raw;
  if (type in IMAGES || type in AUDIO || type in PDF) return type;
  const ext = filename.includes('.') ? filename.split('.').at(-1)!.toLowerCase() : '';
  return type === 'application/octet-stream' || type === '' || type.startsWith('image/') || type.startsWith('audio/')
    ? BY_EXTENSION[ext] || null
    : null;
}
export const kind = (type: string): MediaKind => (type in IMAGES ? 'image' : type in PDF ? 'file' : 'audio');
export function extension(type: string): string {
  const value = UPLOADABLE[type];
  if (!value) throw new RangeError('Unsupported media');
  return value;
}
export function uploadType(contentType: string, filename: string): string | null {
  const type = (contentType || '').split(';')[0]!.trim().toLowerCase();
  if (type in PDF || (['', 'application/octet-stream'].includes(type) && filename.toLowerCase().endsWith('.pdf')))
    return 'application/pdf';
  return mediaType(type, filename);
}
/** Where a signed form puts a file before a note takes it: `web` for the
 * web's, `api` for a token's (`POST /v1/uploads`), so the capture function's
 * role reaches only a token's. Both are tagged pending and expire in a day. */
export const uploadKey = (user: string, id: string, type: string, from: 'web' | 'api' = 'web') =>
  `media/${user}/${from}/${id}.${extension(type)}`;
export const keptKey = (user: string, id: string, type: string) => `media/${user}/files/${id}.${extension(type)}`;
export const key = (user: string, day: string, id: string, n: number, type: string) =>
  `media/${user}/${day}/${id}/${n}.${extension(type)}`;
export const thumbKey = (key: string) => key.replace(/\.[^.]*$/, '') + '.thumb.jpg';
const at = (data: Buffer, start: number, end: number, text: string) =>
  data.subarray(start, end).equals(Buffer.from(text, 'latin1'));
export function looksLike(type: string, data: Buffer): boolean {
  const box = at(data, 4, 8, 'ftyp');
  const checks: Record<string, boolean> = {
    'image/jpeg': at(data, 0, 3, '\xff\xd8\xff'),
    'image/png': at(data, 0, 8, '\x89PNG\r\n\x1a\n'),
    'image/gif': at(data, 0, 6, 'GIF87a') || at(data, 0, 6, 'GIF89a'),
    'image/webp': at(data, 0, 4, 'RIFF') && at(data, 8, 12, 'WEBP'),
    'image/heic': box,
    'image/heif': box,
    'audio/mp4': box,
    'audio/aac': at(data, 0, 2, '\xff\xf1') || at(data, 0, 2, '\xff\xf9'),
    'audio/mpeg': at(data, 0, 3, 'ID3') || (data[0] === 255 && data.length > 1 && (data[1]! & 0xe0) === 0xe0),
    'audio/wav': at(data, 0, 4, 'RIFF') && at(data, 8, 12, 'WAVE'),
    'audio/ogg': at(data, 0, 4, 'OggS'),
    'audio/webm': at(data, 0, 4, '\x1a\x45\xdf\xa3'),
    'audio/flac': at(data, 0, 4, 'fLaC'),
    'application/pdf': at(data, 0, 5, '%PDF-')
  };
  return checks[type] ?? false;
}
export function imageSize(data: Buffer): [number, number] | null {
  try {
    if (at(data, 0, 8, '\x89PNG\r\n\x1a\n')) return [data.readUInt32BE(16), data.readUInt32BE(20)];
    if (at(data, 0, 6, 'GIF87a') || at(data, 0, 6, 'GIF89a')) return [data.readUInt16LE(6), data.readUInt16LE(8)];
    if (at(data, 0, 4, 'RIFF') && at(data, 8, 12, 'WEBP')) {
      const chunk = data.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
      if (chunk === 'VP8L') {
        if (data.length < 25) return null;
        return [
          1 + (((data[22]! & 0x3f) << 8) | data[21]!),
          1 + (((data[24]! & 0xf) << 10) | (data[23]! << 2) | ((data[22]! & 0xc0) >> 6))
        ];
      }
      if (chunk === 'VP8X') return [1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3)];
    }
    if (at(data, 0, 2, '\xff\xd8')) {
      let i = 2;
      while (i + 9 < data.length) {
        if (data[i] !== 255) return null;
        const marker = data[i + 1]!;
        if ([0xd8, 1].includes(marker) || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const length = data.readUInt16BE(i + 2);
        if (length < 2) return null;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)];
        i += 2 + length;
      }
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  return null;
}
export function worthKeeping(type: string, data: Buffer): boolean {
  // A PDF is always sent on purpose; only tiny images are signature clutter.
  if (kind(type) === 'file') return data.length > 0;
  if (kind(type) === 'audio') return data.length >= MIN_AUDIO;
  const size = imageSize(data);
  return size ? Math.max(...size) >= MIN_SIDE : data.length >= MIN_UNREAD;
}
/** Parts use the parser's attachment order, including unsupported raw-only
 * files. A PDF carries its cleaned file name, as a web upload's does. */
export function found(parts: readonly MediaPart[], refused: number[] = []): Array<[string, Buffer, string?]> {
  const out: Array<[string, Buffer, string?]> = [];
  for (const [n, part] of parts.entries()) {
    const type = mediaType(part.type, part.filename);
    if (!type) continue;
    if (!looksLike(type, part.data.subarray(0, HEAD))) {
      refused.push(n);
      continue;
    }
    if (!worthKeeping(type, part.data)) continue;
    const name = kind(type) === 'file' ? fileName(part.filename) : '';
    if (out.length < MAX_FILES) out.push(name ? [type, part.data, name] : [type, part.data]);
    else refused.push(n);
  }
  return out;
}
export async function storeFiles(
  objects: Objects,
  user: string,
  day: string,
  id: string,
  files: readonly (readonly [string, Buffer, string?])[]
): Promise<MediaEntry[]> {
  const entries: MediaEntry[] = [];
  for (const [i, [type, data, name]] of files.entries()) {
    const k = key(user, day, id, i + 1, type);
    await objects.put(k, data, { type, disposition: 'inline' });
    entries.push({ n: i + 1, kind: kind(type), type, size: data.length, key: k, ...(name ? { name } : {}) });
  }
  return entries;
}
export function keys(note: NoteRecord): string[] {
  const out: string[] = [];
  for (const media of note.media ?? []) {
    const found = [media.key, object(media.thumb)?.key];
    if (media.kind === 'image' && String(media.key ?? '').startsWith('media/')) found.push(thumbKey(String(media.key)));
    for (const key of new Set(found.filter(Boolean).map(String))) if (key.startsWith('media/')) out.push(key);
  }
  return out;
}
export const thumbKeys = (note: NoteRecord): string[] =>
  (note.media ?? [])
    .filter((m) => m.kind === 'image' && String(m.key ?? '').startsWith('media/'))
    .map((m) => thumbKey(String(m.key)));
export function counts(notes: readonly NoteRecord[]): Record<string, number> {
  const out: Record<string, number> = { image: 0, audio: 0 };
  for (const note of notes)
    for (const media of note.media ?? []) {
      const kind = String(media.kind);
      out[kind] = (out[kind] ?? 0) + 1;
    }
  return out;
}
/** Attachments shown only as "in the email": refused, of a kind never kept,
 * or a PDF from before emailed PDFs were kept (2026-10-29), which the note's
 * media doesn't hold. Emailed files are keyed by day and message; a file
 * added on the web is under files/ and isn't one of them. */
export function others(note: NoteRecord): number {
  let pdfs = 0;
  const unkept = (Array.isArray(note.attachments) ? note.attachments : []).filter((raw) => {
    const a = object(raw) ?? {};
    if (a.refused) return true;
    const type = mediaType(String(a.content_type ?? ''), String(a.filename ?? ''));
    if (type && type in PDF) pdfs++;
    return !type;
  }).length;
  const kept = (note.media ?? []).filter((m) => m.kind === 'file' && !String(m.key ?? '').includes('/files/')).length;
  return unkept + Math.max(0, pdfs - kept);
}
