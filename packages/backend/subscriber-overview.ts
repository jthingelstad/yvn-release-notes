/** Read-only administrator overview. Inputs are a fixed metadata projection,
 * never note words, tags, links, files, locations, grants or credentials.
 * Entry counts include every channel. Addition time uses mail receipt/writing
 * timestamps and import-ledger update times, not the journal's assigned day.
 * This is current-record metadata, not an activity or delivery audit trail.
 */
import { localDay } from '../domain/dates.ts';
import type { Item } from './store-types.ts';
export interface SubscriberOverview {
  email: string;
  status: 'active' | 'paused' | 'stopped';
  stopped_reason: string | null;
  pause_through: string | null;
  joined_at: string | null;
  tz: string;
  send_time: string;
  last_sent_date: string | null;
  last_added_at: string | null;
  entries: number;
  days: number;
}
const value = (v: unknown) => (typeof v === 'string' && v ? v : null);
const timestamp = (v: unknown) => {
  const s = value(v);
  return s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
};
export function subscriberOverview(items: readonly Item[], now: number): SubscriberOverview[] {
  const users = new Map<string, Item[]>();
  for (const item of items) {
    const pk = String(item.pk);
    if (!pk.startsWith('USER#')) continue;
    if (!users.has(pk)) users.set(pk, []);
    users.get(pk)!.push(item);
  }
  const result: SubscriberOverview[] = [];
  for (const rows of users.values()) {
    const profile = rows.find((r) => r.sk === 'PROFILE');
    if (!profile || profile.mcp_deleting || !value(profile.email)) continue;
    const tz = value(profile.tz) ?? 'America/Chicago',
      today = localDay(now, tz),
      paused =
        value(profile.pause_from) &&
        value(profile.pause_through) &&
        String(profile.pause_from) <= today &&
        today <= String(profile.pause_through),
      notes = rows.filter((r) => String(r.sk).startsWith('NOTE#')),
      additions = rows
        .map((r) => {
          if (String(r.sk).startsWith('IMPORT#')) return timestamp(r.updated_at);
          if (!String(r.sk).startsWith('NOTE#') || r.source === 'import') return null;
          return timestamp(r.received_at) ?? timestamp(r.written_at);
        })
        .filter((s): s is string => s !== null);
    const stopped = profile.status !== undefined && profile.status !== 'active';
    result.push({
      email: String(profile.email),
      status: stopped ? 'stopped' : paused ? 'paused' : 'active',
      stopped_reason:
        stopped && ['unsubscribed', 'bounce', 'complaint'].includes(String(profile.stopped_reason))
          ? String(profile.stopped_reason)
          : null,
      pause_through: !stopped && paused ? String(profile.pause_through) : null,
      joined_at: timestamp(profile.created_at),
      tz,
      send_time: value(profile.send_time) ?? '06:00',
      last_sent_date: value(profile.last_sent_date),
      last_added_at: additions.toSorted().at(-1) ?? null,
      entries: notes.length,
      days: new Set(notes.map((r) => String(r.sk).split('#')[1])).size
    });
  }
  return result.toSorted((a, b) => a.email.localeCompare(b.email));
}
