/** The owner's profile photo (Jamie, 2026-10-28: "I feel like a user should be
 * able to create a Profile photo for themselves"). The browser makes it: the
 * picked photo is decoded on the page, cropped square from its middle and
 * drawn again on a canvas as a 512px JPEG, which carries no EXIF or GPS (a
 * canvas keeps only pixels). So no Sharp here: the web function stays free of
 * native code, as AGENTS.md keeps it. It goes up as any file does
 * (`POST /api/uploads`, a signed form for its exact type and size), and
 * `PUT /api/me/photo` checks the pending upload before keeping it: a JPEG by
 * its bytes, at most PHOTO_MAX, square, PHOTO_MIN to PHOTO_SIDE pixels a
 * side. Its APP1 (EXIF, XMP), APP13 (IPTC) and comment segments are cut out
 * before it is kept (`stripMetadata`), so nothing that could hold GPS is
 * stored, whatever sent it. Refusing them instead turned away every iPhone:
 * Safari's canvas writes a small EXIF block of its own (2026-10-28, Jamie:
 * "I should be able to just add a photo from my phone").
 *
 * Kept at media/<owner>/profile/<id>.jpg, tagged outcome=profile (no
 * lifecycle rule expires it), and named by PROFILE.photo `{key, at, size,
 * side}`. The key is never in an answer: `GET /api/me` says only `photo:
 * {at}`, and the page loads `GET /api/me/photo`, a redirect to a fresh
 * signed link for the owner alone, as a note's file falls back to. A new
 * photo replaces the old one only while PROFILE still names the one read
 * (Store.setPhoto), and the old object is removed after. The activity log
 * says photo.set, photo.changed and photo.removed, never the image. The
 * export zip carries it as profile-photo.jpg; deleting the account removes
 * it with every other object under media/<owner>/. The email never shows
 * it: an email loads nothing remote. */
import { randomUUID } from 'node:crypto';
import { reject, type SessionService } from './sessions.ts';
import { missing } from './services.ts';
import type { Item } from './store-types.ts';
import * as media from './media.ts';
import { profileView } from './views.ts';
import { eventId, recordActivity } from './activity.ts';
import { iso } from '../domain/dates.ts';
import { object } from './places.ts';

export const PHOTO_TYPE = 'image/jpeg',
  PHOTO_SIDE = 512,
  PHOTO_MIN = 128,
  PHOTO_MAX = 256 * 1024;
export const photoKey = (user: string, id: string) => `media/${user}/profile/${id}.jpg`;

/** The stored photo's key, only when it is the owner's own object. */
export function photoOf(profile: Item | null | undefined, user: string): string | null {
  const key = object(profile?.photo)?.key;
  return typeof key === 'string' && key.startsWith(`media/${user}/profile/`) ? key : null;
}

/** Segments that can hold who, where or with what a photo was taken. */
const METADATA = new Set([0xe1, 0xed, 0xfe]);

/** The JPEG with its APP1 (EXIF or XMP, where GPS lives), APP13 (IPTC) and
 * comment segments cut out of the headers before the image data; everything
 * else, colour profile included, is kept byte for byte. Null for a file whose
 * headers cannot be walked. */
export function stripMetadata(data: Buffer): Buffer | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  const kept: Buffer[] = [data.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xda) {
      kept.push(data.subarray(i)); // the image data, to the end
      return Buffer.concat(kept);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(data.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const length = data.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > data.length) return null;
    if (!METADATA.has(marker)) kept.push(data.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  return null;
}

/** The photo checked and kept: `upload` and `type` from `POST /api/uploads`. */
export async function setPhoto(service: SessionService, b: Item): Promise<Item> {
  const { uid, profile: p } = await service.account(),
    ctx = service.context,
    objects = ctx.objects,
    id = b.upload;
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) reject(400, 'upload');
  if (b.type !== PHOTO_TYPE) reject(400, 'photo-type');
  const upload = media.uploadKey(uid, id, PHOTO_TYPE);
  let version: string;
  try {
    const got = await objects.get(upload, { maxBytes: PHOTO_MAX }).catch((error: unknown) => {
      if (error instanceof RangeError) reject(400, 'photo-too-big');
      throw error;
    });
    if (!got.version) reject(400, 'upload');
    version = got.version;
    const [tags, head] = await Promise.all([objects.tags(upload, version), objects.head(upload, version)]);
    if (tags.outcome !== 'pending') reject(400, 'upload');
    if (got.type !== PHOTO_TYPE || !media.looksLike(PHOTO_TYPE, got.body)) reject(400, 'photo-type');
    if (head.size < 1 || head.size > PHOTO_MAX) reject(400, 'photo-too-big');
    const size = media.imageSize(got.body);
    if (!size || size[0] !== size[1] || size[0] < PHOTO_MIN || size[0] > PHOTO_SIDE) reject(400, 'photo-size');
    const clean = stripMetadata(got.body);
    if (!clean) reject(400, 'photo-type');
    const old = photoOf(p, uid),
      key = photoKey(uid, randomUUID().replace(/-/g, '')),
      photo = { key, at: iso(ctx.now), size: clean.length, side: size[0] };
    await objects.put(key, clean, { type: PHOTO_TYPE, tags: { outcome: 'profile' } });
    await objects.remove(upload, version);
    let kept = false;
    try {
      kept = await ctx.store.setPhoto(uid, photo, old);
    } catch (error) {
      if (!refused(error)) {
        await objects.remove(key);
        throw error;
      }
    }
    if (!kept) {
      await objects.remove(key);
      reject(409, 'try-again');
    }
    if (old) await objects.remove(old);
    service.log({ event: 'photo', user: uid, outcome: old ? 'changed' : 'set' });
    await recordActivity(
      ctx.store,
      uid,
      ctx.now,
      [{ kind: old ? 'photo.changed' : 'photo.set', id: eventId(), fields: { via: 'web' } }],
      (f) => service.log(f)
    );
    return profileView({ ...p, photo }, ctx.now, ctx.inboundDomain);
  } catch (error) {
    if (missing(error)) reject(400, 'upload');
    throw error;
  }
}

/** The photo taken off; nothing to take off answers the profile as it is. */
export async function removePhoto(service: SessionService): Promise<Item> {
  const { uid, profile: p } = await service.account(),
    ctx = service.context,
    old = photoOf(p, uid);
  if (!old) return profileView(p, ctx.now, ctx.inboundDomain);
  let dropped = false;
  try {
    dropped = await ctx.store.dropPhoto(uid, old);
  } catch (error) {
    if (!refused(error)) throw error;
  }
  if (!dropped) reject(409, 'try-again');
  await ctx.objects.remove(old);
  service.log({ event: 'photo', user: uid, outcome: 'removed' });
  await recordActivity(
    ctx.store,
    uid,
    ctx.now,
    [{ kind: 'photo.removed', id: eventId(), fields: { via: 'web' } }],
    (f) => service.log(f)
  );
  const rest = { ...p };
  delete rest.photo;
  return profileView(rest, ctx.now, ctx.inboundDomain);
}

/** A fresh signed link to the owner's photo, good for fifteen minutes. */
export async function photoLink(service: SessionService): Promise<string> {
  const { uid, profile: p } = await service.account(),
    key = photoOf(p, uid);
  if (!key) reject(404, 'photo');
  return service.context.objects.download(key, PHOTO_TYPE, 900, {
    disposition: 'inline',
    cache: 'private, max-age=600'
  });
}

/** A conditional refusal: as the store answers it alone, or as the web
 * guard's transaction does once it has merged its proofs into the write. */
function refused(error: unknown): boolean {
  const e = error as { name?: string; CancellationReasons?: { Code?: string }[] };
  return (
    e?.name === 'ConditionalCheckFailedException' ||
    (e?.name === 'TransactionCanceledException' &&
      (e.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed'))
  );
}
