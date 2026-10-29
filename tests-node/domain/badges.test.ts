import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, type Day } from '../../packages/domain/dates.ts';
import { computeVersion } from '../../packages/domain/version.ts';
import {
  album,
  badgeEventsOf,
  BADGES,
  collectedOn,
  evaluateBadges,
  releaseBadges,
  specialKinds,
  unlocked,
  weekEnd,
  type BadgeEvent,
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
  assert.equal(b.missing.length, BADGES.length + 1, 'every badge, and this year’s giving one');
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

test('a pause set for later this week lowers the bar today', () => {
  // Mon 2026-06-01 .. Sun 06-07.
  assert.deepEqual(['2026-06-01', '2026-06-04', '2026-06-07'].map(weekEnd), ['2026-06-07', '2026-06-07', '2026-06-07']);
  // A steady week before, notes Mon to Wed, Thu to Sun paused: on Wednesday
  // the week is steady at three, so the run is two weeks at once.
  const notes = [...run('2026-05-25', 4), ...run('2026-06-01', 3)],
    paused = new Set(run('2026-06-04', 4).map((n) => n.day)),
    b = evaluateBadges(facts(notes, { paused }), '2026-06-03');
  assert.deepEqual([b.tracks.find((t) => t.id === 'cadence')!.best, got(b, 'cadence:alpha')!.day], [2, '2026-06-03']);
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
      { id: 'round', name: 'Round number', count: 2 },
      // Status code once for each status, named with its meaning.
      { id: 'status', name: 'Status code (100 Continue)', count: 1 },
      { id: 'status', name: 'Status code (200 OK)', count: 1 }
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

test('this year’s giving badge is still to find until earned; an earlier year’s never is', () => {
  const notes = [note('2026-10-20')],
    reader = evaluateBadges(facts(notes), '2026-11-03').missing.filter((m) => m.shelf === 'giving');
  assert.deepEqual(reader, [
    {
      id: 'giving-2026',
      name: 'Supported Signal',
      hint: 'Be a Weekly Thing Supporting Member in 2026: membership goes 100% to Signal this year.',
      shelf: 'giving'
    }
  ]);
  const lapsed = [{ year: 2026, first: '2026-10-25', last: '2026-12-01' }],
    nextYear = evaluateBadges(facts(notes, { giving: lapsed }), '2099-01-06').missing;
  assert.ok(!nextYear.some((m) => m.shelf === 'giving'), 'no nonprofit named for the year yet');
  assert.ok(!nextYear.some((m) => m.id === 'giving-2026'), 'an earlier year is never listed');
});

test('a giving year is a badge stamped on the first day a member was seen, in order', () => {
  const notes = [note('2026-10-20'), note('2026-10-28')],
    giving = [
      { year: 2026, first: '2026-10-25', last: '2026-11-03' },
      { year: 2099, first: '2099-01-02', last: '2099-01-02' }
    ],
    b = evaluateBadges(facts(notes, { giving }), '2026-11-03');
  const signal = got(b, 'giving-2026')!;
  assert.equal(signal.name, 'Supported Signal');
  assert.equal(signal.line, 'A Weekly Thing Supporting Member in 2026, the year membership went to Signal.');
  assert.equal(signal.shelf, 'giving');
  assert.deepEqual([signal.earned, signal.day, signal.version], ['2026-10-25', '2026-10-25', v('2026-10-25')]);
  const order = b.earned.map((e) => e.key);
  assert.ok(order.indexOf('giving-2026') < order.indexOf('hello'), 'newest first: after the first note, before now');
  assert.ok(!got(b, 'giving-2099'), 'a year with no nonprofit named waits');
  assert.ok(!b.missing.some((m) => m.shelf === 'giving'), 'earned, so not still to find');
  assert.equal(b.count, evaluateBadges(facts(notes), '2026-11-03').count + 1);
  assert.ok(!got(evaluateBadges(facts(notes, { giving }), '2026-10-24'), 'giving-2026'), 'not before it was seen');
});

// The firsts earned outside notes and the Roadmap (docs/BADGES.md), from
// fictional activity rows, feedback and Upcoming entries.
const row = (at: string, kind: string, extra: Record<string, unknown> = {}) => ({
  sk: `ACTIVITY#${at}#${kind}#r${at.slice(11, 19)}`,
  kind,
  at,
  ...extra
});
const CHICAGO = 'America/Chicago';

test('each first outside notes is stamped with its own day, in the profile’s zone', () => {
  const events = badgeEventsOf(
      {
        activity: [
          // 01:30 UTC on the 12th is still the 11th in Chicago.
          row('2026-10-12T01:30:00.000Z', 'photo.set', { via: 'web' }),
          row('2026-10-13T15:00:00.000Z', 'export.book'),
          row('2026-10-14T15:00:00.000Z', 'note.edited', { via: 'web' }),
          row('2026-10-15T15:00:00.000Z', 'note.edited', { via: 'assistant' })
        ],
        feedback: [
          {
            id: 'f1',
            filed_at: '2026-10-16T15:00:00Z',
            answers: [{ at: '2026-10-17T15:00:00Z', status: 'needs_info' }]
          },
          { id: 'f2', filed_at: '2026-10-18T15:00:00Z', answers: [{ at: '2026-10-19T15:00:00Z', status: 'done' }] }
        ]
      },
      CHICAGO
    ),
    b = evaluateBadges(facts([], { events }), '2026-10-20');
  for (const [key, day] of [
    ['signed', '2026-10-11'],
    ['tarball', '2026-10-13'],
    ['pair', '2026-10-15'],
    ['issue', '2026-10-16'],
    ['merged', '2026-10-19']
  ] as const) {
    const e = got(b, key);
    assert.deepEqual([e?.day, e?.earned, e?.version, e?.shelf], [day, day, v(day), 'first'], key);
  }
  assert.equal(got(b, 'signed')!.name, 'Signed commit');
  assert.equal(got(b, 'issue')!.line, 'Sent feedback.');
  assert.equal(got(b, 'merged')!.line, 'Feedback you sent was marked done.');
  assert.equal(got(b, 'tarball')!.line, 'Made a book of your notes.');
  // A web edit is no pair; only the agent's edit, on the 15th.
  assert.equal(got(b, 'pair')!.day, '2026-10-15');
  assert.ok(!b.missing.some((m) => ['signed', 'issue', 'merged', 'tarball', 'pair'].includes(String(m.id))));
});

test('Merged upstream needs a done answer; feedback alone, or answered otherwise, is only Issue opened', () => {
  const ask = (status: string) =>
      evaluateBadges(
        facts([], {
          events: badgeEventsOf(
            {
              feedback: [
                { id: 'f', filed_at: '2026-10-16T15:00:00Z', answers: [{ at: '2026-10-17T15:00:00Z', status }] }
              ]
            },
            CHICAGO
          )
        }),
        '2026-10-20'
      ),
    hints = Object.fromEntries(evaluateBadges(facts([]), '2026-10-20').missing.map((m) => [m.id, m.hint]));
  for (const status of ['answered', 'needs_info', 'open']) {
    const b = ask(status);
    assert.ok(got(b, 'issue'), status);
    assert.ok(!got(b, 'merged'), status);
  }
  assert.equal(got(ask('done'), 'merged')!.day, '2026-10-17');
  assert.equal(hints.merged, 'Send feedback that gets built or fixed.');
  assert.equal(hints.signed, 'Add a profile photo in Settings.');
  assert.equal(hints.tarball, 'Make a book of your notes, from the Archive or a release’s page.');
  assert.equal(hints.assets, 'Add a photo to a note, here, by email or through an agent.');
  assert.equal(hints.pair, 'Connect an agent in Settings and ask it to add or edit a note.');
  assert.match(String(hints.issue), /You tab/);
});

test('a photo removed keeps Signed commit; a photo with no row counts from the profile', () => {
  // Set, then removed: the profile has no photo now, the row stays.
  const kept = badgeEventsOf(
    { activity: [row('2026-10-12T15:00:00.000Z', 'photo.set'), row('2026-10-13T15:00:00.000Z', 'photo.removed')] },
    CHICAGO
  );
  assert.equal(got(evaluateBadges(facts([], { events: kept }), '2026-10-20'), 'signed')!.day, '2026-10-12');
  // A photo whose row was never written is dated by the profile's own time.
  const fallback = badgeEventsOf({ activity: [], photoAt: '2026-10-14T15:00:00Z' }, CHICAGO);
  assert.equal(got(evaluateBadges(facts([], { events: fallback }), '2026-10-20'), 'signed')!.day, '2026-10-14');
  // With a row, the profile's time (a later change) is not a second event.
  assert.equal(
    badgeEventsOf(
      { activity: [row('2026-10-12T15:00:00.000Z', 'photo.set')], photoAt: '2026-10-18T15:00:00Z' },
      CHICAGO
    ).length,
    1
  );
});

test('the Roadmap counts dates ever added at 1, 5, 15, 40 and 100, by id, and never falls', () => {
  const added = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) =>
        row(`2026-10-${String(1 + ((from + i) % 28)).padStart(2, '0')}T15:00:00.000Z`, 'upcoming.added', {
          upcoming: `e${from + i}`
        })
      ),
    roadmap = (b: Badges) => b.tracks.find((t) => t.id === 'roadmap')!;
  for (const [n, level] of [
    [0, null],
    [1, 'alpha'],
    [4, 'alpha'],
    [5, 'beta'],
    [15, 'rc'],
    [39, 'rc'],
    [40, 'stable'],
    [100, 'LTS']
  ] as const) {
    const b = evaluateBadges(facts([], { events: badgeEventsOf({ activity: added(n) }, CHICAGO) }), '2026-10-30'),
      t = roadmap(b);
    assert.deepEqual([t.best, t.now, t.level?.toLowerCase() ?? null], [n, n, level?.toLowerCase() ?? null], String(n));
  }
  const one = evaluateBadges(facts([], { events: badgeEventsOf({ activity: added(1) }, CHICAGO) }), '2026-10-30');
  assert.equal(got(one, 'roadmap:alpha')!.line, 'Added a date to Upcoming.');
  assert.equal(got(one, 'roadmap:alpha')!.day, '2026-10-01');
  const five = evaluateBadges(facts([], { events: badgeEventsOf({ activity: added(5) }, CHICAGO) }), '2026-10-30');
  assert.equal(got(five, 'roadmap:beta')!.line, '5 dates added to Upcoming.');
  assert.equal(got(five, 'roadmap:beta')!.day, '2026-10-05', 'the day the fifth was added');

  // The union: a row and a saved entry for the same date count once, at the
  // earlier time; an entry from before the log counts by created_at; a date
  // since deleted (a row, no entry) still counts.
  const events = badgeEventsOf(
    {
      activity: [
        row('2026-10-22T15:00:00.000Z', 'upcoming.added', { upcoming: 'kept' }),
        row('2026-10-23T15:00:00.000Z', 'upcoming.added', { upcoming: 'deleted' }),
        row('2026-10-24T15:00:00.000Z', 'upcoming.removed', { upcoming: 'deleted' })
      ],
      upcoming: [
        { id: 'kept', created_at: '2026-10-21T15:00:00Z' },
        { id: 'old', created_at: '2026-10-14T15:00:00Z' }
      ]
    },
    CHICAGO
  );
  assert.deepEqual(events.map((e) => [e.key, e.day]).sort(), [
    ['upcoming:deleted', '2026-10-23'],
    ['upcoming:kept', '2026-10-21'],
    ['upcoming:old', '2026-10-14']
  ]);
  assert.equal(roadmap(evaluateBadges(facts([], { events }), '2026-10-30')).best, 3);
  // Upcoming touches nothing else: no note, day, streak or count.
  const b = evaluateBadges(facts([], { events }), '2026-10-30');
  assert.deepEqual(
    b.tracks.filter((t) => t.id !== 'roadmap').map((t) => t.best),
    [0, 0, 0, 0]
  );
  assert.deepEqual(
    b.earned.map((e) => e.key),
    ['roadmap:alpha']
  );
});

test('events join the replay in time order among the notes, never before the birthday or after today', () => {
  const notes = [note('2026-10-12', { at: '2026-10-12T18:00:00Z' })],
    events: BadgeEvent[] = [
      { kind: 'signed', day: '2026-10-12', at: '2026-10-12T17:00:00.000Z', key: 'a' },
      { kind: 'tarball', day: '2026-10-12', at: '2026-10-12T19:00:00.000Z', key: 'b' },
      { kind: 'issue', day: '2099-01-01', at: '2099-01-01T12:00:00.000Z', key: 'c' },
      { kind: 'merged', day: '1980-01-01', at: '1980-01-01T12:00:00.000Z', key: 'd' }
    ],
    b = evaluateBadges(facts(notes, { events }), '2026-10-20'),
    order = b.earned.map((e) => e.key).reverse();
  // Oldest first: the photo before the note's badges, the book after them.
  assert.equal(order[0], 'signed');
  assert.ok(order.indexOf('hello') < order.indexOf('tarball'));
  assert.equal(got(b, 'issue')!.day, '2026-10-20', 'a time past today is today');
  assert.ok(!got(b, 'merged'), 'nothing before the birthday');
  // And they unlock like a note: before, without the event; after, with it.
  const without = evaluateBadges(facts(notes), '2026-10-20'),
    gained = unlocked(without, b).map((u) => u.key);
  assert.deepEqual(gained.sort(), ['issue', 'signed', 'tarball']);
});

// Easter eggs (docs/BADGES.md): status patches, Found and I’m a teapot.
test('every status patch is a Status code, named with its meaning; 4.0.4 and 4.1.8 happen once', () => {
  const meanings: [number, string][] = [
    [100, 'Continue'],
    [101, 'Switching Protocols'],
    [200, 'OK'],
    [201, 'Created'],
    [204, 'No Content'],
    [301, 'Moved Permanently'],
    [304, 'Not Modified'],
    [307, 'Temporary Redirect']
  ];
  for (const [patch, meaning] of meanings) {
    assert.ok(specialKinds(5, 3, patch, 365).includes('status'), String(patch));
    const day = addDays('2026-03-14', patch);
    assert.equal(v(day), `3.9.${patch}`);
    assert.ok(collectedOn(ADA, day).includes(`Status code (${patch} ${meaning})`), String(patch));
  }
  for (const patch of [102, 202, 302, 404, 418]) assert.ok(!specialKinds(5, 3, patch, 365).includes('status'));
  // A round number and a status both: the round clause and the album say so.
  assert.deepEqual(collectedOn(ADA, addDays('2026-03-14', 200)), ['Round number', 'Status code (200 OK)']);
  assert.deepEqual(specialKinds(4, 0, 4, 366), ['palindrome', 'found']);
  assert.deepEqual(specialKinds(4, 1, 8, 366), ['teapot']);
  // Only the exact version: 5.0.4 is no Found, 4.2.8 no teapot.
  assert.ok(!specialKinds(5, 0, 4, 365).includes('found'));
  assert.ok(!specialKinds(4, 2, 8, 365).includes('teapot'));
  const found = '2027-03-18',
    teapot = '2028-03-22';
  assert.deepEqual([v(found), v(teapot)], ['4.0.4', '4.1.8']);
  const b = evaluateBadges(facts([note(found), note(teapot)]), teapot);
  assert.deepEqual(
    [got(b, 'found')?.name, got(b, 'found')?.line, got(b, 'found')?.version],
    ['Found', '4.0.4, and yet here you are.', '4.0.4']
  );
  assert.deepEqual(
    [got(b, 'teapot')?.name, got(b, 'teapot')?.line, got(b, 'teapot')?.version],
    ['I’m a teapot', '4.1.8. Short and stout.', '4.1.8']
  );
  assert.deepEqual(collectedOn(ADA, teapot), ['I’m a teapot']);
});

test('Status code is earned once and collected in every album; secrets never show Ahead', () => {
  const lastYear = addDays('2025-03-14', 304),
    thisYear = addDays('2026-03-14', 100);
  assert.deepEqual([v(lastYear), v(thisYear)], ['3.8.304', '3.9.100']);
  const b = evaluateBadges(facts([note(lastYear), note(thisYear)]), '2026-10-20');
  assert.equal(got(b, 'status')!.version, '3.8.304');
  assert.equal(b.earned.filter((e) => e.id === 'status').length, 1, 'one lifetime badge');
  assert.deepEqual(
    b.release.collected.filter((c) => c.ids.includes('status')),
    [
      {
        day: thisYear,
        version: '3.9.100',
        ids: ['round', 'status'],
        names: ['Round number', 'Status code (100 Continue)']
      }
    ]
  );
  // The 4.0 release ahead: 4.0.4 is a palindrome too, but Found is never announced.
  const early = evaluateBadges(facts([]), '2027-03-15');
  for (const a of early.release.ahead)
    assert.ok(!a.ids.some((id) => ['status', 'found', 'teapot'].includes(id)), a.version);
  assert.deepEqual(early.release.ahead[0], {
    day: '2027-03-18',
    version: '4.0.4',
    ids: ['palindrome'],
    names: ['Palindrome']
  });
  const beforeRound = evaluateBadges(facts([]), addDays('2027-03-14', 99));
  assert.ok(beforeRound.release.ahead.some((a) => a.version === '4.0.100' && a.ids.join() === 'round'));
  // Unearned, each is its hint alone.
  const none = evaluateBadges(facts([]), '2026-10-20');
  for (const hint of ['Some patches have a status.', 'Lost and found.', 'Short and stout.', 'Tap, tap, tap…'])
    assert.ok(
      none.missing.some((m) => m.secret && m.hint === hint),
      hint
    );
});

test('an egg found earns its secret first once; an unknown egg earns nothing', () => {
  const events = badgeEventsOf(
      {
        activity: [
          row('2026-10-12T15:00:00.000Z', 'egg.found', { via: 'web', egg: 'developer' }),
          row('2026-10-13T15:00:00.000Z', 'egg.found', { via: 'web', egg: 'rtfm' }),
          row('2026-10-14T15:00:00.000Z', 'egg.found', { via: 'web', egg: 'konami' })
        ]
      },
      CHICAGO
    ),
    b = evaluateBadges(facts([], { events }), '2026-10-20');
  assert.deepEqual(
    events.map((e) => e.kind),
    ['developer', 'rtfm']
  );
  const dev = got(b, 'developer')!,
    rtfm = got(b, 'rtfm')!;
  assert.deepEqual(
    [dev.name, dev.line, dev.day, dev.shelf],
    ['Developer mode', 'Tapped your version seven times.', '2026-10-12', 'first']
  );
  assert.deepEqual([rtfm.name, rtfm.line, rtfm.day], ['RTFM', 'Read the manual.', '2026-10-13']);
  const none = evaluateBadges(facts([]), '2026-10-20');
  assert.ok(none.missing.some((m) => m.secret && m.hint === 'Read the manual.'));
  assert.ok(!none.missing.some((m) => m.id === 'developer' || m.id === 'rtfm'));
});
