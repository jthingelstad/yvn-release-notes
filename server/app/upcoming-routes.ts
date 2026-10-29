/** Personal Upcoming entries share the app's session and Origin gates. The
 * calendar feed is the one exception: its private link is the whole proof. */
import { randomUUID } from 'node:crypto';
import { SessionService, reject, type ApiContext } from '../../packages/backend/sessions.ts';
import { batchShape, prepareUpcomingBatch, upcomingContent } from '../../packages/backend/upcoming.ts';
import { replyToken } from '../../packages/backend/accounts.ts';
import { occurrence, upcomingViews, UPCOMING_MAX, type UpcomingEntry } from '../../packages/domain/upcoming.ts';
import { calendarEvents, ics } from '../../packages/domain/calendar.ts';
import { iso, localDay } from '../../packages/domain/dates.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import { eventId, recordActivity, upcomingEvents } from '../../packages/backend/activity.ts';
import { addedEvents, earnedBy } from '../../packages/backend/badges.ts';
import { body, json } from './requests.ts';

export const CALENDAR_NAME = 'Release Notes';
const feedUrl = (ctx: ApiContext, profile: Item) =>
  profile.calendar ? `${ctx.origin}/api/calendar/${profile.calendar}.ics` : null;

export async function upcomingRoutes(
  service: SessionService,
  pattern: string,
  args: string[]
): Promise<Response | null> {
  if (pattern.startsWith('/api/calendar')) return calendarRoutes(service, pattern, args);
  if (!pattern.startsWith('/api/upcoming')) return null;
  const { uid, profile } = await service.account(),
    ctx = service.context,
    store = ctx.store,
    today = localDay(ctx.now, String(profile.tz)),
    at = iso(ctx.now),
    method = service.request.method;
  if (method === 'GET')
    return json({
      entries: upcomingViews(await store.upcomingEntries(uid), today),
      today,
      tz: profile.tz,
      limit: UPCOMING_MAX,
      calendar: feedUrl(ctx, profile)
    });
  const value = await body(service.request);
  if (pattern === '/api/upcoming/batch') {
    const batch = batchShape(value),
      existing = await store.upcomingEntries(uid),
      { changes, count } = await prepareUpcomingBatch(batch, existing, today, at, (q) => service.geocode(q));
    if (value.dry_run === true)
      return json({
        ok: true,
        dry_run: true,
        ...count,
        plan: {
          add: changes.filter((c) => !c.previous).map((c) => c.next),
          change: changes.filter((c) => c.previous && c.next).map((c) => ({ before: c.previous, after: c.next })),
          remove: changes.filter((c) => !c.next).map((c) => c.previous!.id)
        }
      });
    const outcome = await store.upcomingBatch(uid, changes);
    service.log({ event: 'upcoming', user: uid, action: 'batch', ...count, applied: outcome.applied });
    const applied = changes.slice(0, outcome.applied),
      // Dates added count toward the Roadmap; seen only when the page hears
      // of it (a refused batch shows no unlock line).
      won = await earnedBy(store, uid, profile, ctx.now, addedEvents(applied, ctx.now, profile.tz), {
        via: 'web',
        seen: outcome.ok,
        log: (f) => service.log(f)
      });
    await recordActivity(store, uid, ctx.now, [...upcomingEvents(applied, 'web'), ...won.events], (f) =>
      service.log(f)
    );
    if (!outcome.ok) reject(409, 'upcoming-conflict', { applied: outcome.applied });
    return json({ ok: true, ...count, ...(won.unlocked.length ? { unlocked: won.unlocked } : {}) });
  }
  const previous = pattern === '/api/upcoming' ? null : await store.upcoming(uid, args[0]!);
  if (pattern !== '/api/upcoming' && !previous) reject(404, 'upcoming-missing');
  if (previous && (!Number.isSafeInteger(value.revision) || value.revision !== previous.revision))
    reject(409, 'upcoming-changed');
  if (method === 'DELETE' && Object.keys(value).some((field) => field !== 'revision')) reject(400, 'upcoming-fields');
  const next: UpcomingEntry | null =
    method === 'DELETE'
      ? null
      : {
          id: previous?.id ?? randomUUID(),
          ...upcomingContent(value, today),
          revision: (previous?.revision ?? 0) + 1,
          created_at: previous?.created_at ?? at,
          updated_at: at
        };
  if (!(await store.saveUpcoming(uid, next, previous))) reject(409, 'upcoming-conflict');
  const won = await earnedBy(store, uid, profile, ctx.now, addedEvents([{ previous, next }], ctx.now, profile.tz), {
    via: 'web',
    seen: true,
    log: (f) => service.log(f)
  });
  await recordActivity(store, uid, ctx.now, [...upcomingEvents([{ previous, next }], 'web'), ...won.events], (f) =>
    service.log(f)
  );
  service.log({ event: 'upcoming', user: uid, action: method === 'DELETE' ? 'remove' : previous ? 'edit' : 'create' });
  const unlocked = won.unlocked.length ? { unlocked: won.unlocked } : {};
  return json(
    next ? { ...next, occurrence: occurrence(next, today), ...unlocked } : { ok: true },
    previous ? 200 : 201
  );
}

/** The feed link (AGENTS.md, Upcoming): 120 random bits naming the owner, made
 * and replaced here, never at sign-up. Reading the feed takes no session and
 * sets no cookie; the token is never logged, only the owner and a count. */
async function calendarRoutes(service: SessionService, pattern: string, args: string[]): Promise<Response> {
  const ctx = service.context,
    method = service.request.method;
  if (pattern === '/api/calendar/{token}.ics') {
    const token = args[0]!,
      link = await ctx.store.getCalendar(token),
      profile = link ? await ctx.store.profile(String(link.user_id)) : null;
    if (!link || !profile || profile.calendar !== token || profile.mcp_deleting) reject(404, 'not-found');
    const uid = String(link.user_id),
      today = localDay(ctx.now, String(profile.tz)),
      events = calendarEvents(await ctx.store.upcomingEntries(uid), today, new URL(ctx.origin).host);
    service.log({ event: 'calendar', user: uid, action: 'read', events: events.length });
    return new Response(ics(events, { name: CALENDAR_NAME, url: ctx.origin + '/upcoming/' }), {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': 'attachment; filename="release-notes.ics"'
      }
    });
  }
  const { uid, profile } = await service.account(),
    old = profile.calendar ? String(profile.calendar) : null;
  if (method === 'DELETE') {
    if (old && !(await ctx.store.dropCalendar(uid, old))) reject(409, 'try-again');
    service.log({ event: 'calendar', user: uid, action: 'remove' });
    if (old)
      await recordActivity(
        ctx.store,
        uid,
        ctx.now,
        [{ kind: 'calendar.removed', id: eventId(), fields: { via: 'web' } }],
        (f) => service.log(f)
      );
    return json({ ok: true });
  }
  const token = replyToken();
  if (!(await ctx.store.setCalendar(uid, token, iso(ctx.now), old))) reject(409, 'try-again');
  service.log({ event: 'calendar', user: uid, action: old ? 'replace' : 'create' });
  await recordActivity(
    ctx.store,
    uid,
    ctx.now,
    [{ kind: old ? 'calendar.replaced' : 'calendar.created', id: eventId(), fields: { via: 'web' } }],
    (f) => service.log(f)
  );
  return json({ calendar: feedUrl(ctx, { calendar: token }) });
}
