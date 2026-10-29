/** `POST /api/eggs` (domain/eggs.ts; docs/BADGES.md, Easter eggs): the page
 * says an easter egg was found, `{egg}` one of EGGS (400 `egg` otherwise).
 * The session and the Origin are checked as for every cookie write (app.ts).
 * The first time an egg is found it writes one `egg.found` activity row
 * (`egg`, via web), and that row earns the egg's secret first, answered as
 * `unlocked` and marked seen, since the page shows the unlock line; with
 * "Show badges" off the row is still written and nothing is unlocked. Found
 * again, it writes nothing and answers the same `{ok}`. Once is kept by
 * `Store.findEgg`, which claims the egg on the BADGES item in the same
 * transaction as the rows, so two tabs finding it at once write one row;
 * the read before it only spares the work when it was found long ago. The
 * answer never says anything about another egg. A failed write is logged
 * as `activity-unrecorded` and fails nothing; the page never waits on this
 * answer. */
import { reject, type SessionService } from './sessions.ts';
import { eventId } from './activity.ts';
import { earnedBy, freshEvent } from './badges.ts';
import { activityKey, activityRow, activityTime } from '../domain/activity.ts';
import { isEgg } from '../domain/eggs.ts';
import type { Item } from './store-types.ts';

export async function findEgg(service: SessionService, b: Item): Promise<Item> {
  const { uid, profile: p } = await service.account(),
    ctx = service.context,
    egg = b.egg;
  if (!isEgg(egg)) reject(400, 'egg');
  // Found long ago: spare the work. Store.findEgg is what keeps it once.
  const had = await ctx.store.badgeActivity(uid, true);
  if (had.some((r) => r.kind === 'egg.found' && r.egg === egg)) return { ok: true };
  const row = eventId(),
    won = await earnedBy(
      ctx.store,
      uid,
      p,
      ctx.now,
      [freshEvent(egg, activityKey(activityTime(ctx.now), 'egg.found', row), ctx.now, p.tz)],
      { via: 'web', log: (f) => service.log(f) }
    );
  const at = activityTime(ctx.now),
    rows = [{ kind: 'egg.found', id: row, fields: { via: 'web', egg } }, ...won.events].map((e) =>
      activityRow(uid, at, e)
    );
  let written = false;
  try {
    written = await ctx.store.findEgg(uid, egg, rows, at);
  } catch {
    service.log({ event: 'activity-unrecorded', kind: 'egg', user: uid });
    return { ok: true };
  }
  // Another tab found it first, or the account is going: nothing to say.
  if (!written) return { ok: true };
  service.log({ event: 'egg', user: uid, egg });
  // Marked seen only once written, since the page shows the unlock line.
  if (won.unlocked.length)
    try {
      await ctx.store.addSeenBadges(
        uid,
        won.unlocked.map((u) => u.key),
        at
      );
    } catch {
      service.log({ event: 'badges-error', user: uid });
    }
  return won.unlocked.length ? { ok: true, unlocked: won.unlocked } : { ok: true };
}
