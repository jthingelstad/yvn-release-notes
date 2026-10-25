/** Records what happened in an account (packages/domain/activity.ts) after
 * the change itself is saved: a failed write never fails that change, and
 * is logged as activity-unrecorded with the user id and the kind, nothing
 * else, and counted: by a metric filter on the web's log, by an embedded
 * metric (activityLog) where no filter reads the log as JSON. */
import { randomUUID } from 'node:crypto';
import { activityRow, activityTime, familyOf, type ActivityEvent } from '../domain/activity.ts';
import { givingBadge, type Unlocked } from '../domain/badges.ts';
import { givingYears } from '../domain/giving.ts';
import { computeVersion } from '../domain/version.ts';
import type { Item } from './store-types.ts';
import type { Store } from './store.ts';
import type { UpcomingChange } from './upcoming.ts';

export type ActivityStore = Pick<Store, 'putActivity'>;
type Log = (fields: { event: string; kind: string; user: string }) => void;

/** An id for an event that names no note, date or connection. */
export const eventId = (): string => randomUUID().replace(/-/g, '').slice(0, 16);
/** The id for a change that can come to the same thing again within the
 * second a key's time is read to (two appends to one note, two saves of one
 * date): the thing's id and a short random tail, so the second row is not
 * refused as the first. The row's own fields name the thing. */
export const again = (id: string): string => `${id}.${eventId().slice(0, 8)}`;

export async function recordActivity(
  store: ActivityStore,
  user: string,
  now: number,
  events: readonly ActivityEvent[],
  log?: Log
): Promise<boolean> {
  if (!events.length) return true;
  const at = activityTime(now);
  try {
    if (
      await store.putActivity(
        user,
        events.map((e) => activityRow(user, at, e))
      )
    )
      return true;
  } catch {
    // Counted below, like a refusal.
  }
  log?.({ event: 'activity-unrecorded', kind: familyOf(events[0]!.kind), user });
  return false;
}

/** The log for a worker: the line, then an embedded ActivityUnrecorded count,
 * each a bare JSON line on stdout as the census writes its own (console.log
 * would prefix it, and CloudWatch reads a metric only from a whole JSON line). */
export const activityLog =
  (
    now: number,
    log: (fields: Record<string, unknown>) => void = (fields) => process.stdout.write(`${JSON.stringify(fields)}\n`)
  ) =>
  (fields: { event: string; kind: string; user: string }): void => {
    log(fields);
    log({
      _aws: {
        Timestamp: now * 1000,
        CloudWatchMetrics: [
          { Namespace: 'ReleaseNotes', Dimensions: [[]], Metrics: [{ Name: 'ActivityUnrecorded', Unit: 'Count' }] }
        ]
      },
      ActivityUnrecorded: 1
    });
  };

/** One activity row per Upcoming date a save changed; never its title. */
export const upcomingEvents = (changes: readonly UpcomingChange[], via: string, client?: unknown) =>
  changes.map(({ previous, next }) => ({
    kind: !previous ? 'upcoming.added' : next ? 'upcoming.changed' : 'upcoming.removed',
    id: previous && next ? again(next.id) : (next ?? previous)!.id,
    fields: { via, ...(client ? { client } : {}), upcoming: (next ?? previous)!.id }
  }));
/** One row per badge a save earned (packages/domain/activity.ts), never the
 * special days it collected. */
export function badgeEvents(
  unlocked: readonly Unlocked[],
  via: string,
  day: string,
  note: string,
  client?: unknown
): ActivityEvent[] {
  return unlocked
    .filter((u) => !u.album)
    .map((u) => ({
      kind: 'badge.earned',
      id: u.key,
      fields: {
        via,
        ...(client ? { client } : {}),
        badge: u.id,
        key: u.key,
        name: u.name,
        version: u.version,
        day,
        note
      }
    }));
}
/** One row for each giving year (domain/giving.ts) that `fields`, a
 * standing just saved, adds to profile `p`, while "Show badges" is on, as a
 * save's badges get. It names no day or note: membership earned it. A year
 * whose nonprofit is not known yet gets its badge later and no row. */
export function givingEvents(p: Item, fields: Item): ActivityEvent[] {
  if (p.badges === false || !fields.giving) return [];
  const had = new Set(givingYears(p.giving).map((g) => g.year));
  return givingYears(fields.giving)
    .filter((g) => !had.has(g.year))
    .flatMap((g) => {
      const b = givingBadge(g.year);
      if (!b) return [];
      return [
        {
          kind: 'badge.earned',
          id: b.id,
          fields: {
            via: 'weekly-thing',
            badge: b.id,
            key: b.id,
            name: b.name,
            version: String(computeVersion(String(p.birthday), g.first))
          }
        }
      ];
    });
}
