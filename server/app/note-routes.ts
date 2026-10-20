import { randomUUID } from 'node:crypto';
import { SessionService, reject } from '../../packages/backend/sessions.ts';
import { chosenPlace } from '../../packages/backend/accounts.ts';
import { attachUploads, startUpload } from '../../packages/backend/uploads.ts';
import { mediaLinks, noteView, dayView } from '../../packages/backend/views.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import { collect, type Link } from '../../packages/backend/links.ts';
import { unlockedBy } from '../../packages/backend/badges.ts';
import type { Unlocked } from '../../packages/domain/badges.ts';
import * as media from '../../packages/backend/media.ts';
import { keepDay, placeOf } from '../../packages/backend/weather.ts';
import { localDay, iso, validTimezone } from '../../packages/domain/dates.ts';
import { computeVersion } from '../../packages/domain/version.ts';
import { found } from '../../packages/domain/tags.ts';
import { json, body, dayFrom, textFrom } from './requests.ts';
async function keepWeather(service: SessionService, uid: string, p: Item, day: string, changed = false): Promise<void> {
  try {
    await keepDay(
      service.context.store,
      uid,
      placeOf(p),
      String(p.tz),
      day,
      localDay(service.context.now, String(p.tz)),
      service.weatherFetch,
      iso(service.context.now),
      changed
    );
  } catch {
    service.log({ event: 'weather-error', user: uid, date: day });
  }
}
export async function noteRoutes(service: SessionService, pattern: string, args: string[]): Promise<Response | null> {
  if (pattern !== '/api/uploads' && !pattern.startsWith('/api/days/{date}/')) return null;
  if (pattern === '/api/uploads') return json(await startUpload(service, await body(service.request)));
  const { uid, profile: p } = await service.account(),
    ctx = service.context,
    store = ctx.store,
    method = service.request.method,
    day = dayFrom(p, args[0], ctx.now),
    id = args[1],
    links = mediaLinks(ctx.objects, uid);
  if (pattern.endsWith('/place')) {
    if (method === 'PUT') {
      const place = chosenPlace((await body(service.request)).place);
      delete place.from;
      await store.setDayPlace(uid, day, place);
    } else await store.clearDayPlace(uid, day);
    await keepWeather(service, uid, p, day, true);
    const own = await store.dayPlace(uid, day, true),
      sky = (await store.weatherBetween(uid, day, day, true))[day],
      view = await dayView(p, day, [], sky, undefined, own);
    return json(
      Object.fromEntries(['date', 'where', 'weather'].filter((k) => Object.hasOwn(view, k)).map((k) => [k, view[k]]))
    );
  }
  if (pattern === '/api/days/{date}/notes') {
    const b = await body(service.request),
      text = textFrom(b, Boolean(b.uploads)),
      place = b.place != null ? chosenPlace(b.place) : null,
      files = b.uploads ? await attachUploads(service, uid, b.uploads) : [],
      noteId = 'w-' + randomUUID().replace(/-/g, '').slice(0, 20),
      item: Item = {
        version: computeVersion(String(p.birthday), day).toString(),
        text,
        source: 'web',
        written_at: iso(ctx.now),
        tz: validTimezone(b.tz) ? b.tz : p.tz
      },
      named = await collect(text, { fetch: ctx.fetchTitle }),
      tagged = found(text);
    if (named.length) item.links = named;
    if (tagged.length) item.tags = tagged;
    if (files.length) item.media = files.map((f, i) => ({ n: i + 1, ...f }));
    if (place) item.place = place;
    try {
      await store.putNote(uid, day, noteId, item);
    } catch (error) {
      for (const file of files) await ctx.objects.remove(String(file.key));
      throw error;
    }
    await keepWeather(service, uid, p, day);
    const saved = { sk: `NOTE#${day}#${noteId}`, ...item },
      view = await noteView(saved, String(p.tz), Boolean(p.transcribe), links);
    // What it earned, for the line under the form, and then seen, so the
    // email does not say it again. Never a reason to fail a saved note:
    // without it the answer just has no `unlocked`. Nothing with badges off.
    let unlocked: Unlocked[] | null = null;
    if (p.badges !== false)
      try {
        unlocked = await unlockedBy(store, uid, p, localDay(ctx.now, String(p.tz)), saved);
        const earned = unlocked.filter((u) => !u.album).map((u) => u.key);
        if (earned.length) await store.addSeenBadges(uid, earned, iso(ctx.now));
      } catch {
        service.log({ event: 'badges-error', user: uid, date: day });
      }
    return json(unlocked ? { ...view, unlocked } : view, 201);
  }
  const old = id ? await store.note(uid, day, id, true) : null;
  if (!old) reject(404, 'note');
  if (pattern.endsWith('/media/{n}')) {
    const entry = ((old.media as Item[]) ?? []).find((m) => Number(m.n) === Number(args[2])),
      url = entry ? await links(entry.key, String(entry.type)) : null;
    if (!url) reject(404, 'media');
    return json({}, 302, { location: url, 'cache-control': 'private, max-age=300' });
  }
  if (pattern.endsWith('/media')) {
    const uploads = (await body(service.request)).uploads;
    let had = (old.media as Item[]) ?? [];
    if (Array.isArray(uploads) && had.length + uploads.length > media.MAX_FILES) reject(400, 'too-many-files');
    const files = await attachUploads(service, uid, uploads);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (had.length + files.length > media.MAX_FILES) reject(400, 'too-many-files');
        const first = Math.max(0, ...had.map((m) => Number(m.n))) + 1,
          item = await store.addMedia(
            uid,
            day,
            id!,
            files.map((f, i) => ({ n: first + i, ...f })),
            had.length,
            iso(ctx.now)
          );
        if (item) return json(await noteView(item, String(p.tz), Boolean(p.transcribe), links));
        const current = await store.note(uid, day, id!, true);
        if (!current) reject(404, 'note');
        had = (current.media as Item[]) ?? [];
      }
      reject(409, 'busy');
    } catch (error) {
      for (const file of files) await ctx.objects.remove(String(file.key));
      throw error;
    }
  }
  if (method === 'PUT') {
    const text = textFrom(await body(service.request), Boolean((old.media as Item[] | undefined)?.length)),
      named = await collect(text, { keep: old.links as Link[] | undefined, fetch: ctx.fetchTitle }),
      item = await store.updateNote(
        uid,
        day,
        id!,
        text,
        iso(ctx.now),
        named.map((l) => ({ ...l })),
        found(text)
      );
    if (!item) reject(404, 'note');
    return json(await noteView(item, String(p.tz), Boolean(p.transcribe), links));
  }
  for (const key of [
    ...(String(old.raw_key ?? '').startsWith('raw/') ? [String(old.raw_key)] : []),
    ...media.keys(old)
  ])
    await ctx.objects.remove(key);
  await store.deleteNote(uid, day, id!);
  if (old.place) await keepWeather(service, uid, p, day, true);
  for (const key of media.thumbKeys(old)) await ctx.objects.remove(key);
  return json({ ok: true });
}
