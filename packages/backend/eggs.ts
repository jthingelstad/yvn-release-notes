/** `POST /api/eggs` (domain/eggs.ts; docs/BADGES.md, Easter eggs): the page
 * says an easter egg was found, `{egg}` one of EGGS (400 `egg` otherwise).
 * The session and the Origin are checked as for every cookie write (app.ts).
 * The first time an egg is found it writes one `egg.found` activity row
 * (`egg`, via web), and that row earns the egg's secret first, answered as
 * `unlocked` and marked seen, since the page shows the unlock line; with
 * "Show badges" off the row is still written and nothing is unlocked. Found
 * again, it writes nothing and answers the same `{ok}`. The answer never
 * says anything about another egg. A failed activity write is logged as
 * every one is and fails nothing; the page never waits on this answer. */
import { reject, type SessionService } from './sessions.ts';
import { eventId, recordActivity } from './activity.ts';
import { earnedBy, freshEvent } from './badges.ts';
import { activityKey, activityTime } from '../domain/activity.ts';
import { isEgg } from '../domain/eggs.ts';
import type { Item } from './store-types.ts';

export async function findEgg(service: SessionService, b: Item): Promise<Item> {
  const { uid, profile: p } = await service.account(),
    ctx = service.context,
    egg = b.egg;
  if (!isEgg(egg)) reject(400, 'egg');
  // Once an egg: its row is the record that it was found.
  const rows = await ctx.store.badgeActivity(uid, true);
  if (rows.some((r) => r.kind === 'egg.found' && r.egg === egg)) return { ok: true };
  const row = eventId(),
    won = await earnedBy(
      ctx.store,
      uid,
      p,
      ctx.now,
      [freshEvent(egg, activityKey(activityTime(ctx.now), 'egg.found', row), ctx.now, p.tz)],
      { via: 'web', seen: true, log: (f) => service.log(f) }
    );
  await recordActivity(
    ctx.store,
    uid,
    ctx.now,
    [{ kind: 'egg.found', id: row, fields: { via: 'web', egg } }, ...won.events],
    (f) => service.log(f)
  );
  service.log({ event: 'egg', user: uid, egg });
  return won.unlocked.length ? { ok: true, unlocked: won.unlocked } : { ok: true };
}
