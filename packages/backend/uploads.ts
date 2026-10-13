/** Signed forms carry an exact type/size; attachment checks immutable bytes and
 * pending tags, then copies them to a key the form cannot overwrite. */
import { randomUUID } from 'node:crypto';
import { SessionService, reject } from './sessions.ts';
import type { Item } from './store-types.ts';
import { missing } from './services.ts';
import * as media from './media.ts';
import { pythonTrim, codePointSlice } from '../domain/unicode.ts';
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
export async function startUpload(service: SessionService, b: Item): Promise<Item> {
  const { uid } = await service.account(),
    ctype = media.uploadType(typeof b.type === 'string' ? b.type : '', typeof b.name === 'string' ? b.name : '');
  if (!ctype) reject(400, 'file-type');
  const size = b.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) reject(400, 'file-size');
  if (size > media.MAX_UPLOAD) reject(400, 'file-too-big');
  if (
    !(await service.context.store.countUpload(uid, Math.floor(service.context.now / 86400), size, 200, 2 * 1024 ** 3))
  )
    reject(429, 'upload-limit');
  const id = randomUUID().replace(/-/g, ''),
    form = await service.context.objects.upload(media.uploadKey(uid, id, ctype), ctype, size, 300);
  return { upload: id, type: ctype, ...form };
}
export async function attachUploads(service: SessionService, uid: string, value: unknown): Promise<Item[]> {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > media.MAX_FILES ||
    value.some((u) => !u || typeof u !== 'object' || Array.isArray(u)) ||
    new Set(value.map((u) => (u as Item).upload)).size !== value.length
  )
    reject(400, 'upload');
  const entries: Item[] = [],
    checked: { key: string; version: string }[] = [],
    objects = service.context.objects;
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
    const key = media.uploadKey(uid, id, type);
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
      checked.push({ key, version: got.version });
    } catch (e) {
      if (missing(e)) reject(400, 'upload');
      throw e;
    }
  }
  try {
    for (let i = 0; i < entries.length; i++)
      await objects.copy(checked[i]!.key, checked[i]!.version, String(entries[i]!.key), {
        type: String(entries[i]!.type),
        tags: { outcome: 'note' }
      });
    for (const old of checked) await objects.remove(old.key, old.version);
  } catch (error) {
    await Promise.allSettled(entries.map((entry) => objects.remove(String(entry.key))));
    throw error;
  }
  return entries;
}
