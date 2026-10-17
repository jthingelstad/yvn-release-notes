import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  batchFor,
  parseUpcomingText,
  planUpcomingText,
  upcomingLine,
  upcomingText
} from '../../packages/domain/upcoming-text.ts';
import type { UpcomingEntry } from '../../packages/domain/upcoming.ts';
const base = {
  tag: null,
  year: null,
  end_date: null,
  place: null,
  email: true,
  revision: 1,
  created_at: '2026-10-13T12:00:00Z',
  updated_at: '2026-10-13T12:00:00Z'
};
const alex: UpcomingEntry = {
    ...base,
    id: 'a',
    kind: 'birthday',
    title: 'Alex',
    date: '10-20',
    year: 1976,
    reminders: [7, 1, 0]
  },
  hike: UpcomingEntry = {
    ...base,
    id: 'h',
    kind: 'anniversary',
    title: 'Our first hike',
    date: '06-14',
    tag: 'sps',
    reminders: [30, 7, 0]
  },
  zurich: UpcomingEntry = {
    ...base,
    id: 'z',
    kind: 'trip',
    title: 'Winter break',
    date: '2026-12-05',
    end_date: '2026-12-12',
    place: { name: 'Zürich', region: 'Zurich', country: 'Switzerland', tz: 'Europe/Zurich', lat: 47.38, lon: 8.54 },
    reminders: [14, 1, 0]
  },
  concert: UpcomingEntry = {
    ...base,
    id: 'c',
    kind: 'event',
    title: 'Concert #5 @ the park',
    date: '2026-10-01',
    email: false,
    reminders: [7, 1, 0]
  };

test('lines render every field only when it says something, and parse back to the same entries', () => {
  assert.equal(upcomingLine(alex), 'birthday 1976-10-20 Alex');
  assert.equal(upcomingLine(hike), 'anniversary 06-14 Our first hike #sps remind:30,7,0');
  assert.equal(upcomingLine(zurich), 'trip 2026-12-05..2026-12-12 Winter break @Zürich, Zurich, Switzerland');
  assert.equal(upcomingLine(concert), 'event 2026-10-01 "Concert #5 @ the park" email:off');
  const text = upcomingText([concert, zurich, hike, alex]);
  assert.ok(text.startsWith('# One date per line'));
  const { lines, problems } = parseUpcomingText(text);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    lines.map((l) => l.title),
    ['Alex', 'Our first hike', 'Winter break', 'Concert #5 @ the park']
  );
  const plan = planUpcomingText(lines, [alex, hike, zurich, concert]);
  assert.deepEqual([plan.add, plan.change, plan.remove, plan.unchanged], [[], [], [], 4]);
});

test('parsing is forgiving about case and spacing, strict about dates, kinds and options, and names the line', () => {
  const { lines, problems } = parseUpcomingText(
    [
      '# a note to myself',
      '',
      '  Birthday   06-14   Grandma June  ',
      'TRIP 2026-12-05 Day trip @Duluth email:no remind:3,0',
      'event 2026-10-01 Concert email:maybe',
      'lunch 2026-10-01 Concert',
      'birthday 2026-13-01 Nobody',
      'event 2026-10-01..2026-10-02 Two days',
      'trip 2026-12-05..2026-12-01 Backwards @Here',
      'trip 2026-12-05 No destination',
      'birthday 06-14 Someone @Paris',
      'anniversary 06-14',
      'event 2026-10-01 "Unclosed',
      'event 2026-10-01 "Quoted" trailing words #tag',
      'event 2026-10-01 Two tags #a #b',
      'event 2026-10-01 Bad reminders remind:1,x'
    ].join('\n')
  );
  assert.deepEqual(lines, [
    {
      line: 3,
      kind: 'birthday',
      title: 'Grandma June',
      tag: null,
      date: '06-14',
      year: null,
      end_date: null,
      place: null,
      email: null,
      reminders: null
    },
    {
      line: 4,
      kind: 'trip',
      title: 'Day trip',
      tag: null,
      date: '2026-12-05',
      year: null,
      end_date: '2026-12-05',
      place: 'Duluth',
      email: false,
      reminders: [3, 0]
    }
  ]);
  assert.deepEqual(
    problems.map((p) => p.line),
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
  );
  assert.match(problems[1]!.problem, /lunch/);
  assert.match(problems[8]!.problem, /quoted title/);
  assert.match(problems[9]!.problem, /Unexpected text/);
});

test('a plan pairs by kind and folded title, exact dates first, and turns the rest into adds and removes', () => {
  const { lines } = parseUpcomingText(
    [
      'birthday 1976-10-21 alex #family', // same title, folded: a change of date and tag
      'anniversary 06-14 Our first hike #sps remind:30,7,0', // unchanged
      'trip 2026-12-05..2026-12-12 Winter break @Zürich, Zurich, Switzerland email:off', // email changes
      'birthday 03-03 Sam', // new
      'birthday 03-03 Sam' // a second Sam is another entry
    ].join('\n')
  );
  const plan = planUpcomingText(lines, [alex, hike, zurich, concert]);
  assert.deepEqual(
    plan.add.map((l) => [l.line, l.title]),
    [
      [4, 'Sam'],
      [5, 'Sam']
    ]
  );
  assert.deepEqual(
    plan.change.map((c) => [c.entry.id, c.line.line]),
    [
      ['a', 1],
      ['z', 3]
    ]
  );
  assert.deepEqual(
    plan.remove.map((e) => e.id),
    ['c']
  );
  assert.equal(plan.unchanged, 1);
  const batch = batchFor(plan);
  assert.deepEqual(batch.change[0], {
    id: 'a',
    revision: 1,
    kind: 'birthday',
    title: 'alex',
    tag: 'family',
    date: '10-21',
    year: 1976,
    end_date: null,
    place: null,
    email: true,
    reminders: [7, 1, 0]
  });
  assert.deepEqual(batch.change[1]!.email, false);
  assert.deepEqual(batch.change[1]!.place, 'Zürich, Zurich, Switzerland');
  assert.deepEqual(batch.add[0]!.reminders, [7, 1, 0]);
  assert.deepEqual(batch.remove, [{ id: 'c', revision: 1 }]);
  // Two saved Alexes and one line: the exact date keeps its entry, the other goes.
  const twin = { ...alex, id: 'a2', date: '10-21' };
  const again = planUpcomingText(parseUpcomingText('birthday 1976-10-21 Alex').lines, [alex, twin]);
  assert.deepEqual([again.change, again.unchanged, again.remove.map((e) => e.id)], [[], 1, ['a']]);
});
