/** Personal dates are plans, never journal notes. Annual dates use the same
 * March 1 leap-day rollover as birthday versions. Reminder selection depends
 * only on the daily email's local date; it never creates extra sends or writes.
 * Trips retain a destination but do not change home, time zone or note places.
 * An optional tag groups plans; journal tags still live only in note text. */
import { anniversary, daysBetween, parseDay } from './dates.ts';
import { computeVersion } from './version.ts';

export const UPCOMING_KINDS = ['birthday', 'anniversary', 'trip', 'event'] as const;
export type UpcomingKind = (typeof UPCOMING_KINDS)[number];
export const UPCOMING_MAX = 200,
  UPCOMING_TITLE_MAX = 120,
  UPCOMING_SHOWN = 3;
export interface UpcomingPlace {
  name: string;
  region: string;
  country: string;
  tz: string;
  lat: number;
  lon: number;
}
export interface UpcomingEntry {
  id: string;
  kind: UpcomingKind;
  title: string;
  tag: string | null;
  /** MM-DD for annual dates; YYYY-MM-DD for trips and one-time events. */
  date: string;
  year: number | null;
  end_date: string | null;
  place: UpcomingPlace | null;
  email: boolean;
  reminders: number[];
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface Occurrence {
  date: string;
  end_date: string | null;
  days_until: number;
  status: 'upcoming' | 'today' | 'ongoing' | 'past';
  line: string;
}
export interface UpcomingView extends UpcomingEntry {
  occurrence: Occurrence;
}
export interface UpcomingReminder {
  id: string;
  date: string;
  when: string;
  line: string;
}
export interface UpcomingSection {
  shown: UpcomingReminder[];
  more: number;
}
export const annual = (kind: UpcomingKind) => kind === 'birthday' || kind === 'anniversary';
export const defaultReminders = (kind: UpcomingKind) => (kind === 'trip' ? [14, 1, 0] : [7, 1, 0]);

function dateLabel(date: string, today: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' as const } : {})
  }).format(new Date(date + 'T12:00:00Z'));
}

export function occurrence(entry: UpcomingEntry, today: string): Occurrence {
  let date = entry.date;
  if (annual(entry.kind)) {
    const { month, day } = parseDay('2000-' + entry.date);
    let year = parseDay(today).year;
    date = anniversary(year, month, day);
    if (date < today && year < 9999) date = anniversary(++year, month, day);
  }
  const days_until = daysBetween(today, date),
    end_date = entry.kind === 'trip' ? entry.end_date : null,
    status =
      days_until === 0 ? 'today' : days_until > 0 ? 'upcoming' : end_date && end_date >= today ? 'ongoing' : 'past';
  let line = entry.title;
  if (entry.kind === 'birthday') {
    if (entry.year !== null) {
      const v = computeVersion(String(entry.year).padStart(4, '0') + '-' + entry.date, date);
      line += ` turns ${v}.` + (v.minor === 0 && v.major > 0 ? ' A major release.' : '');
    } else line += ' — birthday.';
  } else if (entry.kind === 'anniversary') {
    const years = entry.year === null ? null : parseDay(date).year - entry.year;
    line += years === null ? ' — anniversary.' : ` — ${years} ${years === 1 ? 'year' : 'years'}.`;
  } else if (entry.kind === 'trip') {
    if (entry.place) line += ` — ${entry.place.name}.`;
    line += ` ${dateLabel(date, today)}${end_date && end_date !== date ? ' – ' + dateLabel(end_date, today) : ''}.`;
  } else if (entry.place) line += ` — ${entry.place.name}.`;
  return { date, end_date, days_until, status, line };
}
export function upcomingViews(entries: readonly UpcomingEntry[], today: string): UpcomingView[] {
  return entries
    .map((entry) => ({ ...entry, occurrence: occurrence(entry, today) }))
    .sort(
      (a, b) =>
        Number(a.occurrence.status === 'past') - Number(b.occurrence.status === 'past') ||
        a.occurrence.date.localeCompare(b.occurrence.date) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id)
    );
}
export function remindersFor(entries: readonly UpcomingEntry[], today: string): UpcomingSection {
  const due: UpcomingReminder[] = [];
  for (const entry of entries) {
    if (!entry.email) continue;
    const o = occurrence(entry, today);
    const last =
      entry.kind === 'trip' && entry.end_date === today && o.status !== 'today' && entry.reminders.includes(0);
    if (!last && !entry.reminders.includes(o.days_until)) continue;
    due.push({
      id: entry.id,
      date: last ? today : o.date,
      when: last
        ? 'Last day'
        : o.days_until === 0
          ? 'Today'
          : o.days_until === 1
            ? 'Tomorrow'
            : `In ${o.days_until} days`,
      line: o.line
    });
  }
  due.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return { shown: due.slice(0, UPCOMING_SHOWN), more: Math.max(0, due.length - UPCOMING_SHOWN) };
}
/** Explicit projection for HTTP and exports: never expose table keys. */
export function upcomingEntry(row: Record<string, unknown>): UpcomingEntry {
  return {
    ...Object.fromEntries(
      [
        'id',
        'kind',
        'title',
        'date',
        'year',
        'end_date',
        'place',
        'email',
        'reminders',
        'revision',
        'created_at',
        'updated_at'
      ].map((field) => [field, row[field]])
    ),
    tag: row.tag ?? null
  } as unknown as UpcomingEntry;
}
