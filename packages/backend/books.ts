/** The book (packages/book): a PDF of the owner's notes for any span of days
 * they pick, built by the export worker as the zip is and offered for a day.
 * Books are a thank-you to Weekly Thing Supporting Members (Jamie,
 * 2026-10-25, picking the yearbook among the member perks); the configured
 * administrator may make one too. One at a time, at most MAX_PHOTOS photos. */
import { randomUUID } from 'node:crypto';
import { SessionService, reject } from './sessions.ts';
import { isAdmin } from './product-updates.ts';
import type { Item } from './store-types.ts';
import { iso, localDay } from '../domain/dates.ts';
import { json, body, dayFrom } from '../../server/app/requests.ts';
import { recordActivity } from './activity.ts';
import { defaultTitle } from '../book/data.ts';
import { MAX_PHOTOS, MAX_TITLE } from '../book/limits.ts';

export const mayMakeBook = (p: Item, adminUserId?: string): boolean =>
  p.weekly_thing === 'member' || isAdmin(p, adminUserId);

/** What a span holds, from its notes' keys and files alone. */
async function counted(service: SessionService, uid: string, from: string, to: string) {
  const notes = await service.context.store.notesBetween(uid, from, to, {
      ProjectionExpression: 'sk, #m',
      ExpressionAttributeNames: { '#m': 'media' }
    }),
    media = notes.flatMap((n) => (Array.isArray(n.media) ? (n.media as Item[]) : []));
  return {
    days: new Set(notes.map((n) => String(n.sk).split('#')[1])).size,
    notes: notes.length,
    photos: media.filter((m) => m.kind === 'image' && String(m.key ?? '').startsWith(`media/${uid}/`)).length,
    memos: media.filter((m) => m.kind === 'audio').length
  };
}
function span(p: Item, from: unknown, to: unknown, now: number) {
  const first = dayFrom(p, from, now),
    last = dayFrom(p, to, now);
  if (first > last) reject(400, 'date');
  return { from: first, to: last };
}
function titleFrom(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') reject(400, 'title');
  const title = value.trim().replace(/\s+/gu, ' ');
  if ([...title].length > MAX_TITLE || /\p{Cc}/u.test(title)) reject(400, 'title');
  return title || null;
}

export async function bookRoutes(
  service: SessionService,
  pattern: string,
  query: URLSearchParams
): Promise<Response | null> {
  if (!pattern.startsWith('/api/book')) return null;
  const { uid, profile: p } = await service.account(),
    ctx = service.context,
    store = ctx.store,
    may = mayMakeBook(p, ctx.adminUserId);
  if (pattern === '/api/book/plan') {
    const { from, to } = span(p, query.get('from'), query.get('to'), ctx.now);
    return json({
      from,
      to,
      title: defaultTitle(String(p.birthday), from, to),
      ...(await counted(service, uid, from, to)),
      max_photos: MAX_PHOTOS
    });
  }
  const found = await store.export(uid, 'BOOK'),
    status =
      !found || Number(found.expires_at ?? 0) <= ctx.now
        ? 'none'
        : found.status === 'building' && ctx.now - Number(found.started_at) > 960
          ? 'failed'
          : found.status;
  if (pattern === '/api/book/file') {
    if (status !== 'ready' || !String(found?.export_key ?? '').startsWith(`exports/${uid}/`)) reject(404, 'book');
    return json({}, 302, {
      location: await ctx.objects.download(String(found!.export_key), 'application/pdf', 300, {
        disposition: `attachment; filename="release-notes-${found!.from}-to-${found!.to}.pdf"`
      })
    });
  }
  if (service.request.method === 'POST') {
    if (!may) reject(403, 'book-members');
    if (status === 'building') return json({ status }, 202);
    const b = await body(service.request),
      { from, to } = span(p, b.from, b.to, ctx.now),
      title = titleFrom(b.title),
      held = await counted(service, uid, from, to);
    if (!held.days) reject(400, 'book-empty');
    if (held.photos > MAX_PHOTOS) reject(400, 'book-photos', { photos: held.photos, max_photos: MAX_PHOTOS });
    if (found?.export_key && String(found.export_key).startsWith(`exports/${uid}/`))
      await ctx.objects.remove(String(found.export_key));
    const id = randomUUID().replace(/-/g, '');
    await store.startExport(uid, id, ctx.now, ctx.now + 86400, 'BOOK', { from, to, ...(title ? { title } : {}) });
    try {
      await ctx.invocations.invoke(ctx.exportFunction, { user_id: uid, id, kind: 'book' }, true);
    } catch {
      await store.finishExport(uid, id, { status: 'failed', finished_at: ctx.now }, 'BOOK');
      reject(502, 'book-failed');
    }
    await recordActivity(store, uid, ctx.now, [{ kind: 'export.book', id, fields: { from, to } }], (f) =>
      service.log(f)
    );
    return json({ status: 'building' }, 202);
  }
  return json({
    may,
    today: localDay(ctx.now, String(p.tz)),
    status,
    ...(status !== 'none'
      ? { from: found!.from, to: found!.to, ...(found!.title ? { title: found!.title } : {}) }
      : {}),
    ...(status === 'failed' && found!.reason === 'empty' ? { reason: 'empty' } : {}),
    ...(status === 'ready'
      ? {
          size: Number(found!.size),
          pages: Number(found!.pages ?? 0),
          photos: Number(found!.photos ?? 0),
          missing: Number(found!.missing ?? 0),
          built_at: iso(Number(found!.finished_at)),
          until: iso(Number(found!.expires_at))
        }
      : {})
  });
}
