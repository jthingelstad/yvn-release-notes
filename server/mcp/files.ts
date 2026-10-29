/** Files an agent sends inside a tool call, as base64 with a name and a type
 * (Jamie, 2026-10-28: "the mcp interface doesn't allow an agent to add an
 * image or attachment"). Any MCP tool that takes a file uses this module, so
 * every one checks and keeps files the same way:
 *
 * - The types a web upload takes (`media.UPLOADABLE`: photos, recordings and
 *   PDFs), named as the web names them (`uploadType`), and the first bytes
 *   must look like that type (`media.looksLike`), as a web upload's must.
 * - At most `MAX_INLINE_FILES` files and `MAX_INLINE_BYTES` together in one
 *   call. A synchronous Lambda invoke carries at most 6 MB (6,291,456 bytes)
 *   of request, and base64 makes 4 MiB of bytes 5,592,408 characters, which
 *   leaves room for a note's text and the call around it.
 * - Kept where a web upload's checked copy is kept (`media.keptKey`,
 *   `media/<user>/files/<id>.<ext>`), tagged `outcome=note` before the note
 *   that names it is written, as the web's copy is. The note's media entry
 *   has the web's fields, so the describe and transcribe stream readers make
 *   the thumbnail, read the EXIF time and place, and (only where the owner
 *   opted in) describe or transcribe it exactly as for a web upload.
 * - A file no note took is removed; one left by a crash between the two
 *   writes is an orphan with no note, never a note without its file.
 *
 * Never log a byte, a file name or a type the caller sent. */
import { randomUUID } from 'node:crypto';
import * as media from '../../packages/backend/media.ts';
import { fileName } from '../../packages/backend/uploads.ts';
import type { Objects } from '../../packages/backend/services.ts';
import { object, ToolError } from './common.ts';
export const MAX_INLINE_FILES = 4,
  MAX_INLINE_BYTES = 4 * 1024 * 1024;
/** One file, decoded and checked; `name` is the web's cleaned file name. */
export interface InlineFile {
  type: string;
  name: string;
  data: Buffer;
}
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/,
  // The longest base64 the byte cap allows: every file's padding rounds up.
  MAX_CHARS = Math.ceil(MAX_INLINE_BYTES / 3) * 4 + 4 * MAX_INLINE_FILES;
export const TOO_LARGE = `Send at most ${MAX_INLINE_FILES} files and 4 MB together in one call: add more with notes_attach, a few at a time, or ask the user to upload larger files on the web.`;
const TYPES =
  'Send a photo (JPEG, PNG, GIF, WebP or HEIC), a recording (M4A, AAC, MP3, WAV, OGG, WebM or FLAC) or a PDF, with its MIME type in type.';
/** The tool's `files` argument, checked whole before anything is kept. */
export function inlineFiles(value: unknown): InlineFile[] {
  if (!Array.isArray(value) || !value.length)
    throw new ToolError('invalid_arguments', 'files is a list of {name, type, data} objects.');
  if (value.length > MAX_INLINE_FILES) throw new ToolError('file_too_large', TOO_LARGE);
  let chars = 0;
  for (const file of value) {
    if (
      !object(file) ||
      Object.keys(file).some((k) => !['name', 'type', 'data'].includes(k)) ||
      typeof file.type !== 'string' ||
      typeof file.data !== 'string' ||
      (Object.hasOwn(file, 'name') && typeof file.name !== 'string')
    )
      throw new ToolError(
        'invalid_arguments',
        'Each file is {name, type, data}: data is the base64 of the bytes, type its MIME type.'
      );
    chars += file.data.length;
  }
  // Refuse by length before decoding anything.
  if (chars > MAX_CHARS) throw new ToolError('file_too_large', TOO_LARGE);
  const out: InlineFile[] = [];
  let bytes = 0;
  for (const file of value as Array<{ name?: string; type: string; data: string }>) {
    const name = fileName(file.name ?? ''),
      type = file.type.length <= 100 ? media.uploadType(file.type, name) : null;
    if (!type || !Object.hasOwn(media.UPLOADABLE, type)) throw new ToolError('file_type', TYPES);
    if (!file.data || file.data.length % 4 !== 0 || !BASE64.test(file.data))
      throw new ToolError(
        'invalid_arguments',
        'data is standard base64 (A-Z, a-z, 0-9, + and /, = padding), unbroken.'
      );
    const data = Buffer.from(file.data, 'base64');
    bytes += data.length;
    if (bytes > MAX_INLINE_BYTES) throw new ToolError('file_too_large', TOO_LARGE);
    if (!data.length || !media.looksLike(type, data.subarray(0, media.HEAD)))
      throw new ToolError('file_unreadable', `The bytes are not a ${type} file; send the file itself, base64 encoded.`);
    out.push({ type, name, data });
  }
  return out;
}
/** Keeps checked files where web uploads are kept; returns the note's media
 * entries (without `n`) as `attachUploads` does. A failure removes what it
 * kept and rethrows. */
export async function keepFiles(
  objects: Objects,
  uid: string,
  files: readonly InlineFile[]
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  try {
    for (const file of files) {
      const entry: Record<string, unknown> = {
        kind: media.kind(file.type),
        type: file.type,
        size: file.data.length,
        key: media.keptKey(uid, randomUUID().replace(/-/g, ''), file.type)
      };
      if (file.name) entry.name = file.name;
      const dimensions = Object.hasOwn(media.IMAGES, file.type) ? media.imageSize(file.data) : null;
      if (dimensions) Object.assign(entry, { width: dimensions[0], height: dimensions[1] });
      entries.push(entry);
      await objects.put(String(entry.key), file.data, { type: file.type, tags: { outcome: 'note' } });
    }
  } catch (error) {
    await dropFiles(objects, entries);
    throw error;
  }
  return entries;
}
/** Removes kept files no note took. Never throws: a file left behind has no
 * note and is only storage. */
export async function dropFiles(objects: Objects, entries: readonly Record<string, unknown>[]): Promise<void> {
  await Promise.allSettled(entries.map((entry) => objects.remove(String(entry.key))));
}
