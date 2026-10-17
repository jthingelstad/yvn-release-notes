import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  occurrence,
  remindersFor,
  upcomingMatches,
  upcomingSearchText,
  upcomingViews,
  type UpcomingEntry
} from '../../packages/domain/upcoming.ts';
import { fold } from '../../packages/domain/unicode.ts';
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
  revision: 1,
  created_at: '2026-10-13T12:00:00Z',
  updated_at: '2026-10-13T12:00:00Z'
};
test('birthday versions, unknown years, annual rollover and leap-day policy', () => {
  assert.deepEqual(occurrence(entry, '2026-10-13'), {
    date: '2026-10-20',
    end_date: null,
    days_until: 7,
    status: 'upcoming',
    line: 'Alex turns 5.0.0. A major release.'
  });
  assert.equal(occurrence(entry, '2026-10-20').status, 'today');
  assert.equal(occurrence(entry, '2026-10-21').date, '2027-10-20');
  assert.equal(occurrence({ ...entry, year: null }, '2026-10-13').line, 'Alex — birthday.');
  assert.equal(occurrence({ ...entry, date: '02-29', year: 2000 }, '2027-02-28').date, '2027-03-01');
  assert.equal(occurrence({ ...entry, date: '02-29', year: 2000 }, '2027-03-01').line, 'Alex turns 2.7.0.');
  assert.equal(occurrence({ ...entry, date: '02-29', year: 2000 }, '2028-02-28').date, '2028-02-29');
  assert.equal(occurrence({ ...entry, date: '01-01' }, '2026-12-31').days_until, 1);
  assert.equal(occurrence({ ...entry, kind: 'anniversary', year: 2017 }, '2026-10-13').line, 'Alex — 9 years.');
  assert.equal(occurrence({ ...entry, kind: 'anniversary', year: 2025 }, '2026-10-13').line, 'Alex — 1 year.');
});
test('reminder thresholds, web-only entries, cap, deterministic priority and no daily countdown', () => {
  for (const day of ['2026-10-13', '2026-10-19', '2026-10-20'])
    assert.equal(remindersFor([entry], day).shown.length, 1);
  assert.equal(remindersFor([entry], '2026-10-14').shown.length, 0);
  assert.equal(remindersFor([{ ...entry, email: false }], '2026-10-20').shown.length, 0);
  assert.equal(remindersFor([{ ...entry, reminders: [3] }], '2026-10-17').shown[0]?.when, 'In 3 days');
  const items = ['20', '13', '14', '13', '14'].map((d, i) => ({ ...entry, id: String(i), date: '10-' + d }));
  assert.deepEqual(
    remindersFor(items, '2026-10-13').shown.map((r) => r.id),
    ['1', '3', '2']
  );
  assert.equal(remindersFor(items, '2026-10-13').more, 2);
});
test('trip departure/last day, ongoing/past status and one-day trips appear only once', () => {
  const trip: UpcomingEntry = {
    ...entry,
    kind: 'trip',
    date: '2026-10-20',
    year: null,
    end_date: '2026-10-27',
    reminders: [14, 1, 0]
  };
  assert.equal(remindersFor([trip], '2026-10-06').shown[0]?.when, 'In 14 days');
  assert.equal(occurrence(trip, '2026-10-21').status, 'ongoing');
  assert.equal(remindersFor([trip], '2026-10-21').shown.length, 0);
  assert.equal(remindersFor([trip], '2026-10-27').shown[0]?.when, 'Last day');
  assert.equal(occurrence(trip, '2026-10-28').status, 'past');
  assert.equal(remindersFor([{ ...trip, end_date: trip.date }], '2026-10-20').shown.length, 1);
  assert.equal(remindersFor([{ ...trip, reminders: [1] }], '2026-10-27').shown.length, 0);
  const past = { ...trip, kind: 'event' as const, end_date: null, date: '2026-10-01' };
  assert.equal(remindersFor([past], '2026-10-13').shown.length, 0);
  assert.equal(upcomingViews([past, entry, trip], '2026-10-13').at(-1)?.id, past.id);
});
test('page search reads title, tag, kind, destination and the line, folded, every term required', () => {
  const view = { ...entry, occurrence: occurrence(entry, '2026-10-13') };
  const text = upcomingSearchText(view, 'Birthday');
  for (const terms of [['alex'], ['ALEX'.toLowerCase()], ['5.0.0'], ['major', 'alex'], ['birthday']])
    assert.ok(upcomingMatches(text, terms), terms.join(' '));
  assert.ok(!upcomingMatches(text, ['alex', 'paris']));
  assert.ok(upcomingMatches(text, []));
  const trip = {
    ...entry,
    kind: 'trip' as const,
    title: 'Été à Zürich',
    tag: 'sps',
    date: '2026-10-20',
    year: null,
    end_date: '2026-10-27',
    place: { name: 'Zürich', region: 'Zurich', country: 'Switzerland', tz: 'Europe/Zurich', lat: 47.4, lon: 8.5 }
  };
  const folded = upcomingSearchText({ ...trip, occurrence: occurrence(trip, '2026-10-13') }, 'Trip');
  for (const term of ['ete', 'zurich', 'switzerland', '#sps', 'trip', 'october 20'])
    assert.ok(upcomingMatches(folded, [fold(term)]), term);
});
