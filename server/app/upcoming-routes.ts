/** Personal Upcoming entries share the app's session and Origin gates. */
import { randomUUID } from 'node:crypto';
import { SessionService, reject } from '../../packages/backend/sessions.ts';
import { upcomingContent } from '../../packages/backend/upcoming.ts';
import { occurrence, upcomingViews, UPCOMING_MAX, type UpcomingEntry } from '../../packages/domain/upcoming.ts';
import { iso, localDay } from '../../packages/domain/dates.ts';
import { body, json } from './requests.ts';

export async function upcomingRoutes(
  service: SessionService,
  pattern: string,
  args: string[]
): Promise<Response | null> {
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
      limit: UPCOMING_MAX
    });
  const value = await body(service.request),
    previous = pattern === '/api/upcoming' ? null : await store.upcoming(uid, args[0]!);
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
  service.log({ event: 'upcoming', user: uid, action: method === 'DELETE' ? 'remove' : previous ? 'edit' : 'create' });
  return json(next ? { ...next, occurrence: occurrence(next, today) } : { ok: true }, previous ? 200 : 201);
}
