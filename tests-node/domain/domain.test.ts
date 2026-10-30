import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  addDays,
  daysBetween,
  iso,
  localDay,
  localMoment,
  localStart,
  parseDay,
  validDay,
  validTimezone
} from '../../packages/domain/dates.ts';
import { computeVersion, releaseAge, releaseName, releaseSpan, sameDayBefore } from '../../packages/domain/version.ts';
import { combine, dayLinks, mapUrl, placeLabel, writtenAt } from '../../packages/domain/notes.ts';
import { codePointLength, codePointSlice, fold, pythonTrim } from '../../packages/domain/unicode.ts';
import * as tags from '../../packages/domain/tags.ts';
import { computeStreak, pauseDays } from '../../packages/domain/streak.ts';
import { searchedText, searchTerms } from '../../packages/domain/search.ts';

test('version arithmetic matches all existing sibling-site fixtures', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../tests-node/fixtures/versions.json', import.meta.url), 'utf8'));
  assert.ok(fixture.cases.length > 5000);
  for (const [birthday, today, major, minor, patch, age, cycleDays, daysUntil] of fixture.cases) {
    const value = computeVersion(birthday, today);
    assert.deepEqual(
      [value.major, value.minor, value.patch, value.age, value.cycleDays, value.daysUntil],
      [major, minor, patch, age, cycleDays, daysUntil],
      `${birthday} ${today}`
    );
    assert.equal(String(value), `${major}.${minor}.${patch}`);
  }
});

test('strict calendar dates, leap anniversaries, early years and boundaries', () => {
  assert.deepEqual(parseDay('0001-01-01'), { year: 1, month: 1, day: 1 });
  for (const bad of [
    '2026-02-29',
    '2026-02-30',
    '2026-13-01',
    '0000-01-01',
    '10000-01-01',
    '2026-1-01',
    '2026-01-01T00:00:00Z'
  ])
    assert.equal(validDay(bad), false);
  assert.equal(addDays('0099-12-31', 1), '0100-01-01');
  assert.equal(addDays('2000-02-28', 1), '2000-02-29');
  assert.equal(addDays('1900-02-28', 1), '1900-03-01');
  assert.throws(() => addDays('9999-12-31', 1), RangeError);
  assert.throws(() => addDays('0001-01-01', -1), RangeError);
  assert.equal(String(computeVersion('1972-02-29', '2027-03-01')), '5.5.0');
  assert.deepEqual(releaseSpan('1972-02-29', 55), ['2027-03-01', '2028-02-28']);
  assert.deepEqual(releaseSpan('1972-02-29', 56), ['2028-02-29', '2029-02-28']);
  assert.equal(releaseName(54), '5.4');
  assert.equal(releaseAge('5.4'), 54);
  assert.equal(releaseAge('٣.٥'), 35);
  for (const bad of ['-1.0', '5.10', '1000.0', '5x4', '', '5.4\n']) assert.equal(releaseAge(bad), null);
});

test('local day observes DST and timezone offsets without changing day arithmetic', () => {
  const seconds = (value: string) => Date.parse(value) / 1000;
  assert.equal(localDay(seconds('2026-10-08T04:59:59Z'), 'America/Chicago'), '2026-10-07');
  assert.equal(localDay(seconds('2026-10-08T05:00:00Z'), 'America/Chicago'), '2026-10-08');
  assert.equal(localDay(seconds('2026-03-08T07:59:59Z'), 'America/Chicago'), '2026-03-08');
  assert.equal(localDay(seconds('2026-03-08T08:00:00Z'), 'America/Chicago'), '2026-03-08');
  assert.equal(localDay(seconds('2026-11-01T06:30:00Z'), 'America/Chicago'), '2026-11-01');
  assert.equal(localDay(seconds('2026-11-01T07:30:00Z'), 'America/Chicago'), '2026-11-01');
  assert.equal(localDay(seconds('2026-01-01T12:00:00Z'), 'Pacific/Kiritimati'), '2026-01-02');
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(iso(seconds('2026-10-08T05:00:00.999Z')), '2026-10-08T05:00:00Z');
  assert.equal(validTimezone('Not/AZone'), false);
  assert.equal(validTimezone('+01:00'), false);
  assert.equal(validTimezone('US/Eastern'), true);
});

test('On this day traverses releases by patch and skips short years', () => {
  assert.deepEqual(sameDayBefore('1972-01-03', '2026-10-09').slice(0, 2), ['2025-10-09', '2024-10-08']);
  assert.equal(sameDayBefore('1972-01-03', '2026-10-09').length, 54);
  assert.equal(sameDayBefore('1980-01-01', '2028-12-31')[0], '2024-12-31');
  for (const birthday of ['1972-02-29', '1990-12-31'])
    for (const today of ['2026-03-01', '2028-02-29', '2028-12-31']) {
      const current = computeVersion(birthday, today);
      for (const then of sameDayBefore(birthday, today)) {
        const before = computeVersion(birthday, then);
        assert.equal(before.patch, current.patch);
        assert.ok(before.age < current.age);
      }
    }
});

test('all Unicode codepoints match the independent Python Unicode16 search oracle', () => {
  // Golden digest generated from Python web.fold(chr(cp)) for every codepoint,
  // encoded UTF-16LE with surrogatepass, including standalone surrogates.
  const golden = JSON.parse(readFileSync(new URL('./legacy-golden.json', import.meta.url), 'utf8'));
  const hash = createHash('sha256');
  for (let cp = 0; cp < 0x110000; cp++) hash.update(Buffer.from(fold(String.fromCodePoint(cp)), 'utf16le'));
  assert.equal(hash.digest('hex'), golden.foldSha256);
});

test('synthetic legacy goldens cover Unicode tags, offsets, trimming and quoted search', () => {
  const fixture = JSON.parse(readFileSync(new URL('./legacy-golden.json', import.meta.url), 'utf8'));
  // Letters in any script (2026-10-30) only add tags: every legacy tag and
  // span is still there, in order, and each added one has no a-z letter in
  // its slug, so a tag from before never moves. The golden is unchanged.
  const legacy = (tag: string) => /^[a-z0-9-]+$/.test(tag);
  const added: string[] = [];
  for (const value of fixture.texts) {
    assert.equal(fold(value.text), value.fold);
    assert.deepEqual(tags.found(value.text).filter(legacy), value.tags);
    assert.deepEqual(
      tags.spans(value.text).filter(([, , tag]) => legacy(tag)),
      value.spans
    );
    for (const [, , tag] of tags.spans(value.text))
      if (!legacy(tag)) {
        assert.ok(!/[a-z]/.test(tags.slug(tag)), tag);
        added.push(tag);
      }
    assert.equal(tags.slug(value.text), value.slug);
    assert.equal(tags.withoutClosing(value.text), value.withoutClosing);
    assert.deepEqual(searchTerms(value.text), value.terms);
  }
  // #한국 was no tag before; the rest are the random texts' #Σ, #ς and #한.
  assert.equal(added.length, 9);
  assert.equal(added[0], '한국');
  assert.equal(codePointLength('💡'.repeat(20000)), 20000);
  assert.equal(codePointSlice('💡A💡B', 1, 3), 'A💡');
  assert.equal(pythonTrim('\u001c x \ufeff'), 'x \ufeff');
  assert.equal(fold('Straße Σς ﬃ CAFÉ'), 'strasse σσ ffi cafe');
});

test('hashtags preserve named link parts and use codepoint offsets', () => {
  const link = { url: 'https://example.com/', label: 'example' };
  assert.deepEqual(tags.split(['💡 #Cabin with ', link, ' #kubb']), [
    '💡 ',
    { tag: 'cabin', text: '#Cabin' },
    ' with ',
    link,
    ' ',
    { tag: 'kubb', text: '#kubb' }
  ]);
  assert.equal(
    tags.line(['Tyler', 'Maine 2016', 'tyler', '2016', 'Williamsburg/DC Vacation']),
    '#tyler #maine-2016 #williamsburg-dc-vacation'
  );
  assert.equal(tags.withoutClosing('Dinner\n#Cabin\n#lake'), 'Dinner');
  assert.equal(tags.withoutClosing('Dinner #Cabin'), 'Dinner #Cabin');
});

test('combined notes retain attribution, first named links and legacy timestamps', () => {
  const assistant = { text: 'Tea.', author: 'assistant', client: 'Claude' };
  assert.equal(
    combine([{ text: ' Tea.\n' }, assistant, { ...assistant, client: 'ChatGPT' }, assistant]),
    'Tea.\n\nAdded by Claude:\nTea.\n\nAdded by ChatGPT:\nTea.'
  );
  assert.equal(combine([{ author: 'assistant' }]), 'Added by an agent.');
  assert.equal(combine([{ text: '', media: [] }]), '');
  assert.equal(
    combine([{ text: 'Hi', author: 'assistant', client: '<Agent>' }], { label: (name) => name.replace('<', '&lt;') }),
    'Added by &lt;Agent>:\nHi'
  );
  assert.equal(writtenAt({ received_at: 'old' }), 'old');
  assert.equal(writtenAt({ received_at: 'old', written_at: 'new' }), 'new');
  assert.deepEqual(
    dayLinks([{ links: [{ url: 'x', title: 'first' }] }, { links: [{ url: 'x', title: 'second' }, { url: 'y' }] }]),
    [{ url: 'x', title: 'first' }, { url: 'y' }]
  );
});

test('place labels and map URLs expose names and preserve legacy escaping', () => {
  assert.equal(placeLabel({ label: 'Cabin', city: 'Grand Marais', address: 'Hidden' }), 'Cabin, Grand Marais');
  assert.equal(placeLabel({ city: 'Plymouth', region: 'Minnesota' }), 'Plymouth, Minnesota');
  assert.equal(
    mapUrl({ venue: 'Town Pier', city: 'Bar Harbor', lat: '44.391234', lon: '-68.204321', from: 'entry' }),
    'https://maps.apple.com/?ll=44.391234,-68.204321&q=Town%20Pier,%20Bar%20Harbor'
  );
  assert.equal(mapUrl({ city: 'Home', lat: 44, lon: -93, from: 'home' }), null);
  assert.equal(mapUrl({ city: 'Kyiv' }), null);
  assert.equal(
    mapUrl({ label: 'Café & (tea)!', lat: 0, lon: -0 }),
    'https://maps.apple.com/?ll=0.0,-0.0&q=Caf%C3%A9%20%26%20%28tea%29%21'
  );
});

test('streaks mend late gaps, exclude today and skip paused empty days', () => {
  const today = '2026-10-08',
    ago = (...offsets: number[]) => offsets.map((n) => addDays(today, -n));
  assert.deepEqual(computeStreak([], today), { current: 0, longest: 0, days: [] });
  assert.deepEqual(computeStreak(ago(1, 2, 3), today), { current: 3, longest: 3, days: ago(3, 2, 1) });
  assert.equal(computeStreak(ago(2, 3, 4, 5), today).current, 0);
  assert.equal(computeStreak(ago(1, 2, 5, 6, 7, 8, 9), today).longest, 5);
  assert.equal(computeStreak(ago(1, 3), today).current, 1);
  assert.equal(computeStreak(ago(0, 1, 2, 3), today).current, 3);
  assert.deepEqual(computeStreak(ago(1, 5), today, ago(2, 3, 4)), { current: 2, longest: 2, days: ago(5, 1) });
  assert.equal(computeStreak(ago(3, 4), today, ago(0, 1, 2)).current, 2);
  assert.equal(computeStreak(ago(1, 2, 3), today, ago(2)).current, 3);
  assert.deepEqual([...pauseDays([['2026-10-06', '2026-10-12']], today)].sort(), [
    '2026-10-06',
    '2026-10-07',
    '2026-10-08'
  ]);
});

test('search covers text, place, titles and existing processing results', () => {
  const text = searchedText({
    text: 'Dinner',
    place: { label: 'Café' },
    links: [{ url: 'https://example.com', title: 'Pier' }],
    media: [{ transcript: 'A WALK', description: 'Straße' }]
  });
  for (const word of ['dinner', 'cafe', 'pier', 'a walk', 'strasse']) assert.ok(text.includes(word));
  assert.deepEqual(searchTerms('Café "a walk"'), ['cafe', 'a walk']);
  assert.equal(searchTerms(Array.from({ length: 20 }, (_, n) => `t${n}`).join(' ')).length, 10);
});

test("a local day's first instant, across offsets, DST and days that start at 1am", () => {
  const at = (day: string, tz: string) => new Date(localStart(day, tz) * 1000).toISOString();
  assert.equal(at('2026-10-13', 'America/Chicago'), '2026-10-13T05:00:00.000Z');
  assert.equal(at('2026-03-08', 'America/Chicago'), '2026-03-08T06:00:00.000Z');
  assert.equal(at('2026-03-09', 'America/Chicago'), '2026-03-09T05:00:00.000Z');
  assert.equal(at('2026-11-01', 'America/Chicago'), '2026-11-01T05:00:00.000Z');
  assert.equal(at('2026-11-02', 'America/Chicago'), '2026-11-02T06:00:00.000Z');
  assert.equal(at('2026-10-13', 'UTC'), '2026-10-13T00:00:00.000Z');
  assert.equal(at('2026-10-13', 'Asia/Kolkata'), '2026-10-12T18:30:00.000Z');
  assert.equal(at('2026-10-13', 'Pacific/Chatham'), '2026-10-12T10:15:00.000Z');
  // Midnight never happens: the day starts when the clocks jump.
  assert.equal(at('2026-09-06', 'America/Santiago'), '2026-09-06T04:00:00.000Z');
  assert.equal(at('2026-03-29', 'Asia/Beirut'), '2026-03-28T22:00:00.000Z');
  for (const [day, tz] of [
    ['2026-03-08', 'America/Chicago'],
    ['2026-09-06', 'America/Santiago'],
    ['2026-10-13', 'Pacific/Chatham']
  ] as const) {
    assert.equal(localDay(localStart(day, tz), tz), day);
    assert.equal(localDay(localStart(day, tz) - 1, tz), addDays(day, -1));
  }
});

test('the moment a local day reaches a send time, with the offset then, across DST', () => {
  assert.equal(localMoment('2026-10-13', '06:30', 'America/Chicago'), '2026-10-13T06:30:00-05:00');
  assert.equal(localMoment('2026-11-04', '06:30', 'America/Chicago'), '2026-11-04T06:30:00-06:00');
  assert.equal(localMoment('2026-10-13', '06:00', 'UTC'), '2026-10-13T06:00:00+00:00');
  assert.equal(localMoment('2026-10-13', '06:15', 'Asia/Kolkata'), '2026-10-13T06:15:00+05:30');
  assert.equal(localMoment('2026-10-13', '23:45', 'Pacific/Chatham'), '2026-10-13T23:45:00+13:45');
  // The days the clocks change: a skipped time is the moment of the jump,
  // and a repeated one the first time round, on either side of UTC.
  assert.equal(localMoment('2026-03-08', '06:00', 'America/Chicago'), '2026-03-08T06:00:00-05:00');
  assert.equal(localMoment('2026-03-08', '02:30', 'America/Chicago'), '2026-03-08T03:00:00-05:00');
  assert.equal(localMoment('2026-11-01', '01:30', 'America/Chicago'), '2026-11-01T01:30:00-05:00');
  assert.equal(localMoment('2026-11-01', '06:00', 'America/Chicago'), '2026-11-01T06:00:00-06:00');
  assert.equal(localMoment('2026-03-29', '02:30', 'Europe/Berlin'), '2026-03-29T03:00:00+02:00');
  assert.equal(localMoment('2026-03-29', '03:00', 'Europe/Berlin'), '2026-03-29T03:00:00+02:00');
  assert.equal(localMoment('2026-10-25', '02:30', 'Europe/Berlin'), '2026-10-25T02:30:00+02:00');
  assert.equal(localMoment('2026-10-25', '03:00', 'Europe/Berlin'), '2026-10-25T03:00:00+01:00');
  assert.equal(localMoment('2026-10-04', '02:15', 'Australia/Sydney'), '2026-10-04T03:00:00+11:00');
  assert.equal(localMoment('2026-04-05', '02:30', 'Australia/Sydney'), '2026-04-05T02:30:00+11:00');
  // Lord Howe moves its clocks by half an hour.
  assert.equal(localMoment('2026-04-05', '01:45', 'Australia/Lord_Howe'), '2026-04-05T01:45:00+11:00');
  assert.equal(localMoment('2026-10-04', '02:15', 'Australia/Lord_Howe'), '2026-10-04T02:30:00+11:00');
  // Each is the first quarter hour the sender finds its clock there.
  for (const [day, time, zone] of [
    ['2026-03-29', '02:30', 'Europe/Berlin'],
    ['2026-10-25', '02:30', 'Europe/Berlin'],
    ['2026-03-08', '02:30', 'America/Chicago'],
    ['2026-11-01', '01:30', 'America/Chicago'],
    ['2026-10-04', '02:15', 'Australia/Lord_Howe']
  ] as const) {
    const at = Date.parse(localMoment(day, time, zone)) / 1000,
      [h, m] = time.split(':').map(Number),
      reads = (t: number) => {
        const [d, clock] = new Intl.DateTimeFormat('sv-SE', {
          timeZone: zone,
          dateStyle: 'short',
          timeStyle: 'short'
        })
          .format(new Date(t * 1000))
          .split(' ');
        return d === day && clock! >= `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      };
    assert.ok(reads(at) && !reads(at - 900), `${zone} ${day} ${time}`);
  }
  for (const bad of ['6:00', '24:00', '06:60', 'x'])
    assert.throws(() => localMoment('2026-10-13', bad, 'America/Chicago'), RangeError, bad);
});
