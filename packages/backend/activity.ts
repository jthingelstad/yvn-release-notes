/** Records what happened in an account (packages/domain/activity.ts) after
 * the change itself is saved: a failed write never fails that change, and
 * is logged as activity-unrecorded (counted by a metric filter) with the
 * user id and the kind, nothing else. */
import { randomUUID } from 'node:crypto';
import { activityRow, activityTime, familyOf, type ActivityEvent } from '../domain/activity.ts';
import type { Unlocked } from '../domain/badges.ts';
import type { Store } from './store.ts';
import type { UpcomingChange } from './upcoming.ts';

export type ActivityStore = Pick<Store, 'putActivity'>;
type Log = (fields: { event: string; kind: string; user: string }) => void;

/** An id for an event that names no note, date or connection. */
export const eventId = (): string => randomUUID().replace(/-/g, '').slice(0, 16);

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

/** One activity row per Upcoming date a save changed; never its title. */
export const upcomingEvents = (changes: readonly UpcomingChange[], via: string, client?: unknown) =>
  changes.map(({ previous, next }) => ({
    kind: !previous ? 'upcoming.added' : next ? 'upcoming.changed' : 'upcoming.removed',
    id: (next ?? previous)!.id,
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
