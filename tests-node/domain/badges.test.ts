import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, type Day } from '../../packages/domain/dates.ts';
import { computeVersion } from '../../packages/domain/version.ts';
import {
  album,
  BADGES,
  collectedOn,
  evaluateBadges,
  releaseBadges,
  specialKinds,
  unlocked,
  type BadgeFacts,
  type BadgeNote,
  type Badges
} from '../../packages/domain/badges.ts';

// Fictional subscribers only. Ada here is born 1987-03-14 (the dev
// server's Ada is another, born 1981-06-14).
const ADA = '1987-03-14';
const note = (day: Day, extra: Partial<BadgeNote> = {}): BadgeNote => ({
  day,
  written: extra.written ?? day,
  at: `${extra.written ?? day}T18:00:00Z`,
  source: 'web',
  reply: false,
  assistant: false,
  words: 30,
  tags: [],
  links: 0,
  photos: 0,
  audio: 0,
  placed: false,
  city: 'Springfield',
  country: 'Testland',
  ...extra
});
const facts = (notes: BadgeNote[], extra: Partial<BadgeFacts> = {}): BadgeFacts => ({
  birthday: ADA,
  homeCountry: 'Testland',
  notes,
  weather: {},
  paused: new Set(),
  ...extra
});
const run = (from: Day, days: number, extra: Partial<BadgeNote> = {}) =>
  Array.from({ length: days }, (_, i) => note(addDays(from, i), extra));
const got = (b: Badges, key: string) => b.earned.find((e) => e.key === key);
const keys = (b: Badges) => new Set(b.earned.map((e) => e.key));
const v = (day: Day) => String(computeVersion(ADA, day));

test("Ada's album: the next three special days, never a secret one", () => {
  const b = evaluateBadges(facts([]), '2026-10-20');
  assert.equal(v('2026-10-20'), '3.9.220');
  assert.deepEqual(b.release.ahead, [
    { day: '2027-01-01', version: '3.9.293', ids: ['palindrome'], names: ['Palindrome'] },
    { day: '2027-01-08', version: '3.9.300', ids: ['round'], names: ['Round number'] },
    { day: '2027-03-13', version: '3.9.364', ids: ['code-freeze'], names: ['Code freeze'] }
  ]);
  assert.deepEqual(b.release.following, { v: '4.0', date: '2027-03-14' });
  // 3.9.256 and 3.9.314 are secret, so they are found, never announced.
  assert.deepEqual(specialKinds(3, 9, 256, 365), ['overflow']);
  assert.deepEqual(specialKinds(3, 9, 314, 365), ['pi']);
  assert.deepEqual(specialKinds(4, 0, 0, 366), ['release-day', 'major']);
  assert.deepEqual(specialKinds(4, 5, 67, 365), ['straight']);
  assert.deepEqual(specialKinds(5, 4, 45, 365), ['palindrome']);
  assert.equal(b.count, 0);
  assert.equal(b.missing.length, BADGES.length);
  for (const m of b.missing.filter((x) => x.secret))
    assert.deepEqual(Object.keys(m).sort(), ['hint', 'secret', 'shelf']);
});

test('a first week: firsts, and Continuous delivery stamped with the day it came true', () => {
  const notes = [
    note('2026-10-05', { source: 'email', reply: true, words: 12 }),
    ...run('2026-10-06', 6, { source: 'web' })
  ];
  const b = evaluateBadges(facts(notes), '2026-10-11');
  for (const key of ['hello', 'ack', 'web', 'commit', 'delivery:alpha', 'delivery:beta']) assert.ok(got(b, key), key);
  assert.equal(got(b, 'hello')!.version, v('2026-10-05'));
  assert.equal(got(b, 'delivery:alpha')!.day, '2026-10-07');
  assert.equal(got(b, 'delivery:beta')!.version, v('2026-10-11'));
  assert.equal(got(b, 'delivery:beta')!.name, 'Continuous delivery beta');
  assert.ok(!got(b, 'webhook') && !got(b, 'hotfix') && !got(b, 'patches:alpha'));
  assert.equal(b.earned[0]!.key, 'delivery:beta', 'newest first');
  const delivery = b.tracks.find((t) => t.id === 'delivery')!;
  assert.deepEqual([delivery.tier, delivery.level, delivery.best, delivery.now], [2, 'beta', 7, 7]);
  assert.deepEqual(delivery.next, { level: 'rc', at: 30 });
  assert.deepEqual(delivery.since, { day: '2026-10-11', version: v('2026-10-11') });
});

test('a break keeps the tier; a late note mends its day and earns on the day it was written', () => {
  const notes = [
    ...run('2026-09-01', 2),
    ...run('2026-09-04', 2),
    note('2026-09-03', { written: '2026-09-09' }),
    note('2026-09-20')
  ];
  const b = evaluateBadges(facts(notes), '2026-09-25');
  assert.equal(got(b, 'delivery:alpha')!.day, '2026-09-09');
  assert.equal(got(b, 'hotfix')!.day, '2026-09-09');
  const delivery = b.tracks.find((t) => t.id === 'delivery')!;
  assert.deepEqual([delivery.best, delivery.now, delivery.level], [5, 0, 'alpha']);
});

test('paused days neither break a run nor add to it; a paused week lowers the bar, a fully paused one is skipped', () => {
  const paused = new Set(run('2026-06-03', 3).map((n) => n.day));
  const short = evaluateBadges(facts([...run('2026-06-01', 2), note('2026-06-06')], { paused }), '2026-06-07');
  assert.equal(short.tracks.find((t) => t.id === 'delivery')!.best, 3);

  // Mon 2026-06-01: a steady week, a week paused but for two days with
  // notes on both, a fully paused week, then a steady week.
  const weekPause = new Set([...run('2026-06-08', 5).map((n) => n.day), ...run('2026-06-15', 7).map((n) => n.day)]);
  const notes = [...run('2026-06-01', 4), ...run('2026-06-13', 2), ...run('2026-06-22', 4)];
  const b = evaluateBadges(facts(notes, { paused: weekPause }), '2026-06-28');
  const cadence = b.tracks.find((t) => t.id === 'cadence')!;
  assert.deepEqual([cadence.best, cadence.now, cadence.level], [3, 3, 'alpha']);
  assert.equal(got(b, 'cadence:alpha')!.day, '2026-06-14');
  // The week in progress joins as soon as it is steady, and never breaks.
  const midweek = evaluateBadges(facts(notes, { paused: weekPause }), '2026-06-23');
  assert.equal(midweek.tracks.find((t) => t.id === 'cadence')!.now, 2);
});

test('Hotfix and Backport are for filling in, never for imports', () => {
  const imported = [
    note('2026-01-10', { source: 'import', written: '2026-03-01' }),
    note('2026-01-11', { source: 'import', written: '2026-01-12' })
  ];
  const none = evaluateBadges(facts(imported), '2026-10-20');
  assert.ok(!got(none, 'hotfix') && !got(none, 'backport'));
  const late = evaluateBadges(
    facts([...imported, note('2026-01-12', { written: '2026-02-20', source: 'agent', assistant: true })]),
    '2026-10-20'
  );
  assert.equal(got(late, 'backport')!.day, '2026-02-20');
  assert.equal(got(late, 'hotfix')!.day, '2026-02-20');
  assert.equal(got(late, 'pair')!.day, '2026-02-20');
  // A day that already had a note is added to, not fixed.
  const added = evaluateBadges(
    facts([note('2026-01-12'), note('2026-01-12', { written: '2026-01-13' })]),
    '2026-10-20'
  );
  assert.ok(!got(added, 'hotfix'));
});

test('collectibles carry the special version, whenever the note was written', () => {
  const pi = '2026-01-22'; // 3.8.314
  assert.equal(v(pi), '3.8.314');
  const b = evaluateBadges(facts([note(pi, { written: '2026-10-01' })]), '2026-10-20');
  const found = got(b, 'pi')!;
  assert.deepEqual([found.name, found.version, found.day, found.earned], ['Pi', '3.8.314', pi, '2026-10-01']);
  assert.ok(!b.missing.some((m) => m.secret && m.hint === 'Irrational.'));
  assert.ok(b.missing.some((m) => m.secret && m.hint === 'The answer.'));
  // This release's album shows what it collected, secrets included once found.
  const day42 = addDays('2026-03-14', 42),
    now = evaluateBadges(facts([note(day42), note('2026-03-14')]), '2026-10-20');
  assert.deepEqual(now.release.collected, [
    { day: '2026-03-14', version: '3.9.0', ids: ['release-day'], names: ['Release day'] },
    { day: day42, version: '3.9.42', ids: ['dont-panic'], names: ['Don’t panic'] }
  ]);
  assert.ok(got(now, 'release-day') && got(now, 'dont-panic'));
});

test('a February 29 birthday: Release day is March 1 in common years; Leap patch needs a 366-day release', () => {
  const leap = '2004-02-29';
  assert.equal(album(leap, 1)[0]!.day, '2005-03-01');
  assert.ok(!album(leap, 3).some((d) => d.kinds.includes('leap')));
  const long = album(leap, 4).find((d) => d.kinds.includes('leap'))!;
  assert.deepEqual(long, { day: '2009-02-28', version: '0.4.365', kinds: ['code-freeze', 'leap'] });
  assert.equal(album(ADA, 32).find((d) => d.kinds.includes('leap'))!.version, '3.2.365');
});

test('coverage climbs per release and never shows a tier that can no longer be reached', () => {
  // 3.9 runs 2026-03-14 to 2027-03-13: 365 days, beta at 183.
  const early = evaluateBadges(facts(run('2026-03-14', 100)), '2026-06-21');
  assert.deepEqual([early.release.days, early.release.percent, early.release.level], [100, 27, 'alpha']);
  assert.deepEqual(early.release.next, { level: 'beta', at: 183, more: 83 });
  const late = evaluateBadges(facts(run('2026-03-14', 100)), '2027-01-20');
  assert.equal(late.release.next, null);
  const coverage = late.tracks.find((t) => t.id === 'coverage')!;
  assert.deepEqual([coverage.level, coverage.best, coverage.release], ['alpha', 27, '3.9']);
  assert.equal(got(late, 'coverage:alpha')!.day, addDays('2026-03-14', 91));
});

test('Backward compatible stamps the newer of the pair, whichever was written first', () => {
  const newer = '2026-06-22',
    older = '2025-06-22';
  assert.equal(v(newer), '3.9.100');
  assert.equal(v(older), '3.8.100');
  const b = evaluateBadges(facts([note(newer), note(older, { written: '2026-07-01' })]), '2026-10-20');
  assert.deepEqual([got(b, 'compatible')!.version, got(b, 'compatible')!.earned], ['3.9.100', '2026-07-01']);
});

test('craft and conditions count stored fields only', () => {
  const day = '2026-08-10';
  const b = evaluateBadges(
    facts(
      [
        note(day, { words: 600, photos: 1, tags: ['a', 'b', 'c', 'd', 'e'] }),
        note(day, { written: day, words: 450, audio: 1, links: 2, tags: ['f', 'g', 'h', 'i', 'j'] }),
        note('2026-08-11', { source: 'email', reply: false, placed: true, city: 'Lyon', country: 'France' }),
        ...['A', 'B', 'C'].map((c, i) => note(addDays('2026-08-12', i), { city: c })),
        note('2026-01-05'),
        note('2026-07-20'),
        note('2026-04-02'),
        note('2026-04-03')
      ],
      {
        weather: {
          '2026-01-05': { high_c: -4, code: 73 },
          '2026-07-20': { high_c: 33.1, code: 0 },
          '2026-04-02': { high_c: 9, code: 63 }
        }
      }
    ),
    '2026-10-20'
  );
  for (const key of [
    'fullstack',
    'rfc',
    'taxonomy',
    'dependencies',
    'assets',
    'audio',
    'tag',
    'webhook',
    'geotagged',
    'i18n',
    'multiregion',
    'cold',
    'hot',
    'allweather'
  ])
    assert.ok(got(b, key), key);
  assert.ok(!got(b, 'ack') && !got(b, 'commit'));
});

test('Version history: notes in five releases, imports included', () => {
  const days = [0, 1, 2, 3, 4].map((i) => `${2011 + i}-06-01`);
  const b = evaluateBadges(facts(days.map((d) => note(d, { source: 'import' }))), '2026-10-20');
  assert.equal(got(b, 'history')!.day, days[4]);
  assert.ok(keys(b).has('hello'));
});

test('a save unlocks what the shelf lacked without it, in the order it came true', () => {
  const first = note('2026-10-20');
  assert.deepEqual(
    unlocked(evaluateBadges(facts([]), '2026-10-20'), evaluateBadges(facts([first]), '2026-10-20')).map((u) => u.key),
    ['hello', 'web']
  );
  // Nothing new: an empty list, never a repeat.
  const again = facts([first, note('2026-10-20', { at: '2026-10-20T19:00:00Z' })]);
  assert.deepEqual(unlocked(evaluateBadges(facts([first]), '2026-10-20'), evaluateBadges(again, '2026-10-20')), []);
});

test('a special day collected again unlocks its album entry, after any new badge', () => {
  const lastYear = addDays('2025-03-14', 300),
    today = '2027-01-08';
  assert.deepEqual([v(lastYear), v(today)], ['3.8.300', '3.9.300']);
  const before = facts([note(lastYear)]),
    after = facts([note(lastYear), note(today)]);
  assert.deepEqual(unlocked(evaluateBadges(before, today), evaluateBadges(after, today)), [
    { key: 'compatible', id: 'compatible', name: 'Backward compatible', version: '3.9.300' },
    { key: 'round@2027-01-08', id: 'round', name: 'Round number', version: '3.9.300', album: true }
  ]);
  // The first round number is the badge itself, told once.
  assert.deepEqual(
    unlocked(evaluateBadges(facts([]), lastYear), evaluateBadges(facts([note(lastYear)]), lastYear)).map((u) => [
      u.key,
      u.album ?? false
    ]),
    [
      ['hello', false],
      ['web', false],
      ['round', false]
    ]
  );
});

test("a day's collected names, and a release's coverage and special days by kind", () => {
  assert.deepEqual(collectedOn(ADA, '2027-01-01'), ['Palindrome']);
  assert.deepEqual(collectedOn(ADA, '2027-03-14'), ['Release day', 'Major release']);
  assert.deepEqual(collectedOn(ADA, '2026-10-20'), []);
  const start = '2026-03-14',
    some = new Set([start, addDays(start, 100), addDays(start, 200), '2025-06-22']);
  assert.deepEqual(releaseBadges(ADA, 39, some), {
    coverage: null,
    collected: [
      { id: 'release-day', name: 'Release day', count: 1 },
      { id: 'round', name: 'Round number', count: 2 }
    ]
  });
  const every = new Set(Array.from({ length: 365 }, (_, i) => addDays(start, i))),
    all = releaseBadges(ADA, 39, every);
  assert.equal(all.coverage, 'LTS');
  assert.ok(all.collected.some((c) => c.id === 'pi'));
  assert.equal(
    releaseBadges(ADA, 39, new Set(Array.from({ length: 92 }, (_, i) => addDays(start, i)))).coverage,
    'alpha'
  );
});
