/** The private iCalendar feed of a subscriber's Upcoming dates: one all-day
 * event per trip or one-time event, and one per year of an annual date, so a
 * birthday carries the version it turns that year. Dates roll a leap day to
 * March 1 as the email does. No alarms: reminders travel only in the daily
 * email. Unchanged entries serialize identically, so calendar apps that poll
 * the feed update their copies in place. Runs in Node and the browser. */
import { addDays, anniversary, parseDay } from './dates.ts';
import { annual, anniversaryYears, birthdayVersion, majorRelease, type UpcomingEntry } from './upcoming.ts';

/** Annual dates appear once a year, from last year through three years ahead. */
export const CALENDAR_YEARS_BACK = 1,
  CALENDAR_YEARS_AHEAD = 3;
export interface CalendarEvent {
  uid: string;
  /** Inclusive first day and exclusive last day, as iCalendar all-day events are. */
  start: string;
  end: string;
  summary: string;
  description: string;
  location: string;
  category: string;
  created: string;
  modified: string;
  sequence: number;
}
const CATEGORIES = { birthday: 'Birthday', anniversary: 'Anniversary', trip: 'Trip', event: 'Event' } as const;

function describe(entry: UpcomingEntry, date: string): { summary: string; notes: string[] } {
  const notes: string[] = [];
  let summary = entry.title;
  if (entry.kind === 'birthday') {
    const v = birthdayVersion(entry, date);
    summary += v ? ` turns ${v}` : ' — birthday';
    if (v && majorRelease(v)) notes.push('A major release.');
  } else if (entry.kind === 'anniversary') {
    const years = anniversaryYears(entry, date);
    summary += years === null ? ' — anniversary' : ` — ${years} ${years === 1 ? 'year' : 'years'}`;
  } else if (entry.place) summary += ` — ${entry.place.name}`;
  if (entry.tag) notes.push('#' + entry.tag);
  return { summary, notes };
}
function event(entry: UpcomingEntry, uid: string, start: string, last: string, fallback: string): CalendarEvent {
  const { summary, notes } = describe(entry, start),
    place = entry.place;
  return {
    uid,
    start,
    end: addDays(last, 1),
    summary,
    description: notes.join('\n'),
    location: place ? [place.name, place.region, place.country].filter(Boolean).join(', ') : '',
    category: CATEGORIES[entry.kind],
    created: typeof entry.created_at === 'string' ? entry.created_at : fallback,
    modified: typeof entry.updated_at === 'string' ? entry.updated_at : fallback,
    sequence: Number.isSafeInteger(entry.revision) ? entry.revision : 0
  };
}
/** Every saved date as events, oldest first. `host` makes the UIDs global. */
export function calendarEvents(entries: readonly UpcomingEntry[], today: string, host: string): CalendarEvent[] {
  const thisYear = parseDay(today).year,
    fallback = today + 'T00:00:00Z',
    events: CalendarEvent[] = [];
  for (const entry of entries) {
    if (!annual(entry.kind)) {
      const last = entry.kind === 'trip' && entry.end_date ? entry.end_date : entry.date;
      events.push(event(entry, `${entry.id}@${host}`, entry.date, last, fallback));
      continue;
    }
    const { month, day } = parseDay('2000-' + entry.date);
    for (let year = thisYear - CALENDAR_YEARS_BACK; year <= thisYear + CALENDAR_YEARS_AHEAD; year++) {
      // Nothing before the original date: a 2026 anniversary has no 2025 instance.
      if (entry.year !== null && year < entry.year) continue;
      const date = anniversary(year, month, day);
      events.push(event(entry, `${entry.id}-${year}@${host}`, date, date, fallback));
    }
  }
  return events.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
}

const CRLF = '\r\n';
/** TEXT values: backslash, semicolon, comma and line breaks are escaped (RFC 5545 3.3.11). */
export const escapeText = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utf8Length = (codePoint: number) => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4);
/** Content lines are at most 75 octets; longer ones continue on lines that
 * start with a space, split between characters, never inside one (3.1). */
export function fold(line: string): string {
  let out = '',
    width = 0;
  for (const char of line) {
    const length = utf8Length(char.codePointAt(0)!);
    if (width + length > 75) {
      out += CRLF + ' ';
      width = 1;
    }
    out += char;
    width += length;
  }
  return out;
}
const dateValue = (day: string) => day.replace(/-/g, '');
/** 2026-10-13T12:00:00Z (or with fractional seconds) as 20261013T120000Z. */
export const stampValue = (iso: string) => iso.replace(/\.\d+(?=Z$)/, '').replace(/[-:]/g, '');
export interface CalendarOptions {
  /** The calendar's name in the app that subscribes. */
  name: string;
  /** Where each event points: the Upcoming page. */
  url: string;
}
export function ics(events: readonly CalendarEvent[], options: CalendarOptions): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Your Version Number//Release Notes//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + escapeText(options.name),
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H'
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      'UID:' + e.uid,
      'DTSTAMP:' + stampValue(e.modified),
      'DTSTART;VALUE=DATE:' + dateValue(e.start),
      'DTEND;VALUE=DATE:' + dateValue(e.end),
      'SUMMARY:' + escapeText(e.summary),
      ...(e.description ? ['DESCRIPTION:' + escapeText(e.description)] : []),
      ...(e.location ? ['LOCATION:' + escapeText(e.location)] : []),
      'CATEGORIES:' + escapeText(e.category),
      'URL:' + options.url,
      'TRANSP:TRANSPARENT',
      'CREATED:' + stampValue(e.created),
      'LAST-MODIFIED:' + stampValue(e.modified),
      'SEQUENCE:' + e.sequence,
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join(CRLF) + CRLF;
}
