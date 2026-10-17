/** The feed's events and iCalendar text: yearly instances carry that year's
 * version, trips span their days, long and non-ASCII lines fold on characters. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarEvents, escapeText, fold, ics, stampValue } from '../../packages/domain/calendar.ts';
import type { UpcomingEntry } from '../../packages/domain/upcoming.ts';
const entry: UpcomingEntry = {
  id: 'alex',
  kind: 'birthday',
  tag: null,
  title: 'Alex',
  date: '10-20',
  year: 1976,
  end_date: null,
  place: null,
  email: true,
  reminders: [7, 1, 0],
  revision: 3,
  created_at: '2026-10-13T12:00:00Z',
  updated_at: '2026-10-14T08:30:00.250Z'
};
const paris = { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 };
test('annual dates appear once a year with that year’s version or count, never before they began', () => {
  const events = calendarEvents([entry], '2026-10-13', 'notes.example.com');
  assert.deepEqual(
    events.map((e) => [e.uid, e.start, e.end, e.summary, e.description]),
    [
      ['alex-2025@notes.example.com', '2025-10-20', '2025-10-21', 'Alex turns 4.9.0', ''],
      ['alex-2026@notes.example.com', '2026-10-20', '2026-10-21', 'Alex turns 5.0.0', 'A major release.'],
      ['alex-2027@notes.example.com', '2027-10-20', '2027-10-21', 'Alex turns 5.1.0', ''],
      ['alex-2028@notes.example.com', '2028-10-20', '2028-10-21', 'Alex turns 5.2.0', ''],
      ['alex-2029@notes.example.com', '2029-10-20', '2029-10-21', 'Alex turns 5.3.0', '']
    ]
  );
  assert.deepEqual(events[0], {
    uid: 'alex-2025@notes.example.com',
    start: '2025-10-20',
    end: '2025-10-21',
    summary: 'Alex turns 4.9.0',
    description: '',
    location: '',
    category: 'Birthday',
    created: '2026-10-13T12:00:00Z',
    modified: '2026-10-14T08:30:00.250Z',
    sequence: 3
  });
  assert.deepEqual(
    calendarEvents([{ ...entry, year: null, tag: 'family' }], '2026-10-13', 'h').map((e) => [e.summary, e.description]),
    Array(5).fill(['Alex — birthday', '#family'])
  );
  const leap = calendarEvents([{ ...entry, date: '02-29', year: 2000 }], '2027-06-01', 'h');
  assert.deepEqual(
    leap.map((e) => [e.start, e.summary]),
    [
      ['2026-03-01', 'Alex turns 2.6.0'],
      ['2027-03-01', 'Alex turns 2.7.0'],
      ['2028-02-29', 'Alex turns 2.8.0'],
      ['2029-03-01', 'Alex turns 2.9.0'],
      ['2030-03-01', 'Alex turns 3.0.0']
    ]
  );
  const recent = calendarEvents([{ ...entry, kind: 'anniversary', title: 'Wed', year: 2026 }], '2026-10-13', 'h');
  assert.deepEqual(
    recent.map((e) => [e.start, e.summary, e.category]),
    [
      ['2026-10-20', 'Wed — 0 years', 'Anniversary'],
      ['2027-10-20', 'Wed — 1 year', 'Anniversary'],
      ['2028-10-20', 'Wed — 2 years', 'Anniversary'],
      ['2029-10-20', 'Wed — 3 years', 'Anniversary']
    ]
  );
  assert.equal(
    calendarEvents([{ ...entry, kind: 'anniversary', year: null }], '2026-10-13', 'h')[0]?.summary,
    'Alex — anniversary'
  );
});
test('trips span their inclusive days, events take one, places become locations, order is by date', () => {
  const trip: UpcomingEntry = {
    ...entry,
    id: 'trip',
    kind: 'trip',
    title: 'Holiday',
    date: '2026-10-20',
    year: null,
    end_date: '2026-10-27',
    place: paris
  };
  const concert: UpcomingEntry = {
    ...entry,
    id: 'gig',
    kind: 'event',
    title: 'Concert',
    date: '2026-09-01',
    year: null,
    place: null,
    created_at: undefined as unknown as string,
    updated_at: undefined as unknown as string
  };
  const events = calendarEvents(
    [trip, concert, { ...concert, id: 'g2', date: '2026-10-20', place: paris }],
    '2026-10-13',
    'h'
  );
  assert.deepEqual(
    events.map((e) => [e.uid, e.start, e.end, e.summary, e.location, e.category]),
    [
      ['gig@h', '2026-09-01', '2026-09-02', 'Concert', '', 'Event'],
      ['g2@h', '2026-10-20', '2026-10-21', 'Concert — Paris', 'Paris, Ile-de-France, France', 'Event'],
      ['trip@h', '2026-10-20', '2026-10-28', 'Holiday — Paris', 'Paris, Ile-de-France, France', 'Trip']
    ]
  );
  // A row without times (none exist, but nothing depends on it) is stamped with the day.
  assert.equal(events[0]?.modified, '2026-10-13T00:00:00Z');
  assert.equal(calendarEvents([{ ...trip, end_date: '2026-10-20' }], '2026-10-13', 'h')[0]?.end, '2026-10-21');
});
test('iCalendar text: CRLF, escaped values, stamps without separators, 75-octet folding on characters', () => {
  const text = ics(
    calendarEvents(
      [
        {
          ...entry,
          kind: 'event',
          id: 'e',
          title: 'Dinner; with Sam, Alex \\ co',
          date: '2026-10-20',
          year: null,
          tag: 'sps',
          place: paris
        }
      ],
      '2026-10-13',
      'notes.example.com'
    ),
    { name: 'Release Notes', url: 'https://notes.example.com/upcoming/' }
  );
  assert.equal(
    text,
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Your Version Number//Release Notes//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Release Notes',
      'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
      'X-PUBLISHED-TTL:PT12H',
      'BEGIN:VEVENT',
      'UID:e@notes.example.com',
      'DTSTAMP:20261014T083000Z',
      'DTSTART;VALUE=DATE:20261020',
      'DTEND;VALUE=DATE:20261021',
      'SUMMARY:Dinner\\; with Sam\\, Alex \\\\ co — Paris',
      'DESCRIPTION:#sps',
      'LOCATION:Paris\\, Ile-de-France\\, France',
      'CATEGORIES:Event',
      'URL:https://notes.example.com/upcoming/',
      'TRANSP:TRANSPARENT',
      'CREATED:20261013T120000Z',
      'LAST-MODIFIED:20261014T083000Z',
      'SEQUENCE:3',
      'END:VEVENT',
      'END:VCALENDAR',
      ''
    ].join('\r\n')
  );
  assert.equal(escapeText('a\nb'), 'a\\nb');
  assert.equal(stampValue('2026-10-13T12:00:00Z'), '20261013T120000Z');
  assert.equal(fold('SUMMARY:' + 'a'.repeat(67)), 'SUMMARY:' + 'a'.repeat(67));
  assert.equal(fold('SUMMARY:' + 'a'.repeat(68)), 'SUMMARY:' + 'a'.repeat(67) + '\r\n a');
  // Three-byte characters never split: 24 of them fill 72 octets, the 25th starts a new line.
  const folded = fold('SUMMARY:' + 'é'.repeat(40) + '\u{1F389}');
  for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
  assert.equal(folded.replace(/\r\n /g, ''), 'SUMMARY:' + 'é'.repeat(40) + '\u{1F389}');
  assert.ok(folded.split('\r\n').every((line, i) => i === 0 || line.startsWith(' ')));
});
test('an empty list is still a calendar', () => {
  const text = ics([], { name: 'Release Notes', url: 'https://notes.example.com/upcoming/' });
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n') && text.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!text.includes('VEVENT'));
});
