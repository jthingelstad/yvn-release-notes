/** The book (packages/book): a PDF of the owner's notes for any span of days
 * they pick, at 6 by 9 inches or US Letter, built by the export worker as
 * the zip is and offered for a day. Anyone may make one (Jamie, 2026-10-25:
 * "Anyone can make a book without model support. Cheap and easy."). One at
 * a time, at most MAX_PHOTOS photos. A Supporting Member (or the
 * administrator) may tick a box to have Claude add commentary
 * (book/commentary.ts) to a book of up to a year of days: that tick is the
 * consent for that book alone, and ten finished ones a release are theirs. */
import { randomUUID } from 'node:crypto';
import { SessionService, reject } from './sessions.ts';
import type { Item } from './store-types.ts';
import { iso, localDay } from '../domain/dates.ts';
import { json, body, dayFrom } from '../../server/app/requests.ts';
import { recordActivity } from './activity.ts';
import { earnedBy, freshEvent } from './badges.ts';
import { activityKey, activityTime } from '../domain/activity.ts';
import { defaultTitle } from '../book/data.ts';
import {
  COMMENTARY_DAYS,
  COMMENTARY_PER_RELEASE,
  MAX_PHOTOS,
  MAX_TITLE,
  isPageSize,
  type PageSize
} from '../book/limits.ts';
import { isAdmin } from './product-updates.ts';
import { addDays } from '../domain/dates.ts';
import { computeVersion, releaseName } from '../domain/version.ts';

/** Who may add Claude's commentary: a thank-you to Supporting Members. */
export const mayAnnotate = (p: Item, adminUserId?: string): boolean =>
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
function pageFrom(value: unknown): PageSize {
  if (value === undefined || value === null) return '6x9';
  if (!isPageSize(value)) reject(400, 'book-page');
  return value;
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
    today = localDay(ctx.now, String(p.tz)),
    may = mayAnnotate(p, ctx.adminUserId),
    // The release this year of life is: what a book with commentary counts against.
    release = computeVersion(String(p.birthday), today).age;
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
    if (status === 'building') return json({ status }, 202);
    const b = await body(service.request),
      { from, to } = span(p, b.from, b.to, ctx.now),
      title = titleFrom(b.title),
      page = pageFrom(b.page),
      annotate = b.commentary === true;
    if (b.commentary !== undefined && typeof b.commentary !== 'boolean') reject(400, 'book-commentary');
    if (annotate) {
      if (!may) reject(403, 'book-commentary-members');
      if (to > addDays(from, COMMENTARY_DAYS - 1)) reject(400, 'book-commentary-days', { max_days: COMMENTARY_DAYS });
      if ((await store.commentaryMade(uid, release)) >= COMMENTARY_PER_RELEASE) reject(409, 'book-commentary-left');
    }
    const held = await counted(service, uid, from, to);
    if (!held.days) reject(400, 'book-empty');
    if (held.photos > MAX_PHOTOS) reject(400, 'book-photos', { photos: held.photos, max_photos: MAX_PHOTOS });
    if (found?.export_key && String(found.export_key).startsWith(`exports/${uid}/`))
      await ctx.objects.remove(String(found.export_key));
    const id = randomUUID().replace(/-/g, '');
    await store.startExport(uid, id, ctx.now, ctx.now + 86400, 'BOOK', {
      from,
      to,
      page,
      ...(title ? { title } : {}),
      ...(annotate ? { commentary: true, release } : {})
    });
    try {
      await ctx.invocations.invoke(ctx.exportFunction, { user_id: uid, id, kind: 'book' }, true);
    } catch {
      await store.finishExport(uid, id, { status: 'failed', finished_at: ctx.now }, 'BOOK');
      reject(502, 'book-failed');
    }
    // The first book asked for earns Tarball (docs/BADGES.md), seen here:
    // the Book page shows the unlock line.
    const won = await earnedBy(
      store,
      uid,
      p,
      ctx.now,
      [freshEvent('tarball', activityKey(activityTime(ctx.now), 'export.book', id), ctx.now, p.tz)],
      { via: 'web', seen: true, log: (f) => service.log(f) }
    );
    await recordActivity(
      store,
      uid,
      ctx.now,
      [{ kind: 'export.book', id, fields: { from, to, ...(annotate ? { commentary: true } : {}) } }, ...won.events],
      (f) => service.log(f)
    );
    return json(won.unlocked.length ? { status: 'building', unlocked: won.unlocked } : { status: 'building' }, 202);
  }
  return json({
    today,
    status,
    // What this member may still add; absent for anyone who may not.
    ...(may
      ? {
          commentary: {
            left: Math.max(0, COMMENTARY_PER_RELEASE - (await store.commentaryMade(uid, release))),
            max: COMMENTARY_PER_RELEASE,
            release: releaseName(release),
            max_days: COMMENTARY_DAYS
          }
        }
      : {}),
    ...(status !== 'none'
      ? {
          from: found!.from,
          to: found!.to,
          page: isPageSize(found!.page) ? found!.page : '6x9',
          ...(found!.title ? { title: found!.title } : {}),
          ...(found!.commentary === true ? { annotated: true } : {})
        }
      : {}),
    ...(status === 'failed' && (found!.reason === 'empty' || found!.reason === 'commentary')
      ? { reason: found!.reason }
      : {}),
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
