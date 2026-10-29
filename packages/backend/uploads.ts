/** Signed forms carry an exact type/size; attachment checks immutable bytes and
 * pending tags, then copies them to a key the form cannot overwrite. The web
 * (under a session) and a token (`/v1`, in the capture function) take files
 * the same way, each from its own pending prefix (`media.uploadKey`). */
import { randomUUID } from 'node:crypto';
import { SessionService, reject } from './sessions.ts';
import type { Item } from './store-types.ts';
import { missing, type Objects } from './services.ts';
import * as media from './media.ts';
export const fileName = media.fileName;
/** An account's forms a UTC day, the web's and every token's together. */
export const UPLOADS_A_DAY = 200,
  UPLOAD_BYTES_A_DAY = 2 * 1024 ** 3,
  /** How long a signed form is good for. */
  FORM_SECONDS = 300;
export type UploadFrom = 'web' | 'api';
export interface UploadRequest {
  type: string;
  size: number;
}
/** A form's request, checked: a type the web takes, and the file's exact size. */
export function uploadRequest(b: Item): UploadRequest {
  const type = media.uploadType(typeof b.type === 'string' ? b.type : '', typeof b.name === 'string' ? b.name : '');
  if (!type) reject(400, 'file-type');
  const size = b.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) reject(400, 'file-size');
  if (size > media.MAX_UPLOAD) reject(400, 'file-too-big');
  return { type, size };
}
/** The signed form for one file already counted. */
export async function uploadForm(
  objects: Objects,
  uid: string,
  request: UploadRequest,
  from: UploadFrom = 'web'
): Promise<Item> {
  const id = randomUUID().replace(/-/g, ''),
    form = await objects.upload(media.uploadKey(uid, id, request.type, from), request.type, request.size, FORM_SECONDS);
  return { upload: id, type: request.type, ...form };
}
export async function startUpload(service: SessionService, b: Item): Promise<Item> {
  const { uid } = await service.account(),
    request = uploadRequest(b);
  if (
    !(await service.context.store.countUpload(
      uid,
      Math.floor(service.context.now / 86400),
      request.size,
      UPLOADS_A_DAY,
      UPLOAD_BYTES_A_DAY
    ))
  )
    reject(429, 'upload-limit');
  return uploadForm(service.context.objects, uid, request);
}
/** Uploads checked and copied for a note: the entries to write, and the
 * pending versions they came from, to remove once the note has them. */
export interface Claimed {
  entries: Item[];
  pending: { key: string; version: string }[];
}
/** Checks each upload (1 to 20, distinct) against the bytes that arrived and
 * copies the version it checked to a kept key, tagged note. A failed copy
 * removes the copies made; the pending files are left for the caller. */
export async function claimUploads(
  objects: Objects,
  uid: string,
  value: unknown,
  from: UploadFrom = 'web'
): Promise<Claimed> {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > media.MAX_FILES ||
    value.some((u) => !u || typeof u !== 'object' || Array.isArray(u)) ||
    new Set(value.map((u) => (u as Item).upload)).size !== value.length
  )
    reject(400, 'upload');
  const entries: Item[] = [],
    pending: Claimed['pending'] = [];
  for (const u of value as Item[]) {
    const id = u.upload,
      type = u.type;
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{32}$/.test(id) ||
      typeof type !== 'string' ||
      !Object.hasOwn(media.UPLOADABLE, type)
    )
      reject(400, 'upload');
    const key = media.uploadKey(uid, id, type, from);
    try {
      const got = await objects.get(key, { range: `bytes=0-${media.HEAD - 1}`, maxBytes: media.HEAD });
      if (!got.version) reject(400, 'upload');
      const [tags, head] = await Promise.all([objects.tags(key, got.version), objects.head(key, got.version)]);
      if (
        tags.outcome !== 'pending' ||
        got.type !== type ||
        !media.looksLike(type, got.body) ||
        head.size < 1 ||
        head.size > media.MAX_UPLOAD
      )
        reject(400, 'upload');
      const entry: Item = {
          kind: media.kind(type),
          type,
          size: head.size,
          key: media.keptKey(uid, randomUUID().replace(/-/g, ''), type)
        },
        name = fileName(u.name);
      if (name) entry.name = name;
      const dimensions = Object.hasOwn(media.IMAGES, type) ? media.imageSize(got.body) : null;
      if (dimensions) Object.assign(entry, { width: dimensions[0], height: dimensions[1] });
      entries.push(entry);
      pending.push({ key, version: got.version });
    } catch (e) {
      if (missing(e)) reject(400, 'upload');
      throw e;
    }
  }
  // Copies run in S3, side by side: twenty files of 50 MB one after another
  // could outlast the function. Every copy settles before any is removed,
  // so none lands after the clean-up.
  const copied = await Promise.allSettled(
      entries.map((entry, i) =>
        objects.copy(pending[i]!.key, pending[i]!.version, String(entry.key), {
          type: String(entry.type),
          tags: { outcome: 'note' }
        })
      )
    ),
    failed = copied.find((c) => c.status === 'rejected');
  if (failed) {
    await dropCopies(objects, entries);
    throw failed.reason;
  }
  return { entries, pending };
}
/** Removes the kept copies of entries no note took. */
export async function dropCopies(objects: Objects, entries: readonly Item[]): Promise<void> {
  await Promise.allSettled(entries.map((entry) => objects.remove(String(entry.key))));
}
export async function attachUploads(service: SessionService, uid: string, value: unknown): Promise<Item[]> {
  const objects = service.context.objects,
    { entries, pending } = await claimUploads(objects, uid, value);
  try {
    for (const old of pending) await objects.remove(old.key, old.version);
  } catch (error) {
    await dropCopies(objects, entries);
    throw error;
  }
  return entries;
}
