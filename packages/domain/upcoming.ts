/** Personal dates are plans, never journal notes. Annual dates use the same
 * March 1 leap-day rollover as birthday versions. Reminder selection depends
 * only on the daily email's local date; it never creates extra sends or writes.
 * Trips retain a destination but do not change home, time zone or note places.
 * Tags group plans as they do notes (docs/TAGS.md): keys in `tags`, the names
 * as typed in `tag_names`. `tag`, the first key, is read for one release
 * (API 1.21.0) by clients written for one tag a date. */
import { anniversary, daysBetween, parseDay } from './dates.ts';
import { storedTags } from './tags.ts';
import { computeVersion } from './version.ts';
import { fold } from './unicode.ts';

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
  tags: string[];
  tag_names: string[];
  /** The first key: deprecated in API 1.21.0, gone in the next release. */
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
/** The email's section, and every reminder due that morning, those folded
 * into "and N more" included: the activity log has a row for each. */
export interface UpcomingDue extends UpcomingSection {
  due: UpcomingReminder[];
}
export const annual = (kind: UpcomingKind) => kind === 'birthday' || kind === 'anniversary';
export const defaultReminders = (kind: UpcomingKind) => (kind === 'trip' ? [14, 1, 0] : [7, 1, 0]);
/** The version a birthday with a known year turns on one of its dates, by the site's arithmetic. */
export const birthdayVersion = (entry: UpcomingEntry, date: string) =>
  entry.year === null ? null : computeVersion(String(entry.year).padStart(4, '0') + '-' + entry.date, date);
export const majorRelease = (v: { major: number; minor: number }) => v.minor === 0 && v.major > 0;
/** How many years an anniversary with a known year marks on one of its dates. */
export const anniversaryYears = (entry: UpcomingEntry, date: string) =>
  entry.year === null ? null : parseDay(date).year - entry.year;

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
    const v = birthdayVersion(entry, date);
    if (v) line += ` turns ${v}.` + (majorRelease(v) ? ' A major release.' : '');
    else line += ' — birthday.';
  } else if (entry.kind === 'anniversary') {
    const years = anniversaryYears(entry, date);
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
export function remindersFor(entries: readonly UpcomingEntry[], today: string): UpcomingDue {
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
  return { shown: due.slice(0, UPCOMING_SHOWN), more: Math.max(0, due.length - UPCOMING_SHOWN), due };
}
/** What the page's search reads, folded like note search: the title, tags, kind,
 * destination and the occurrence line (so "5.0.0" or "major" find a birthday). */
export function upcomingSearchText(view: UpcomingView, kindName: string): string {
  const place = view.place;
  return fold(
    [
      view.title,
      storedTags(view)
        .map((t) => `#${t.key} #${t.name}`)
        .join(' '),
      kindName,
      place ? [place.name, place.region, place.country].filter(Boolean).join(', ') : '',
      view.occurrence.line
    ].join('\n')
  );
}
/** Every term must appear (AND), as in note search. No terms match everything. */
export const upcomingMatches = (text: string, terms: readonly string[]) => terms.every((term) => text.includes(term));
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
    ...upcomingTags(row)
  } as unknown as UpcomingEntry;
}
/** A date's tags as every reader sees them, a row from before 2026-11-08
 * (one `tag`) included. */
export function upcomingTags(row: { tags?: unknown; tag_names?: unknown; tag?: unknown }) {
  const tags = storedTags(row);
  return { tags: tags.map((t) => t.key), tag_names: tags.map((t) => t.name), tag: tags[0]?.key ?? null };
}
