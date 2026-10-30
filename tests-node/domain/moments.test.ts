/** A moment's values (docs/MOMENTS.md): what is kept as sent, what is
 * tidied, what is refused and where, and the plain line each piece is
 * shown as. Fictional values only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOMENT_ITEMS,
  distanceText,
  durationText,
  momentKinds,
  momentOf,
  momentParts,
  storedMoment,
  usesMiles,
  type Moment
} from '../../packages/domain/moments.ts';

const WALK: Moment = {
  at: '2026-10-11T07:40:00-05:00',
  items: [
    { kind: 'workout', activity: 'walking', distance_m: 5150, duration_s: 2890 },
    { kind: 'song', title: 'A Song', artist: 'A Band' },
    { kind: 'steps', count: 8214, movement: 'walking' },
    { kind: 'feeling', labels: ['calm', 'grateful'], valence: 'pleasant' },
    { kind: 'event', title: 'Picnic', place: 'The Park', hosted: true },
    { kind: 'people', names: ['Ana', 'Ben', 'Cy'] },
    { kind: 'reflection', prompt: 'What made today good?' }
  ]
};

const ok = (value: unknown) => {
  const read = momentOf(value);
  assert.ok('moment' in read, JSON.stringify(read));
  return read.moment;
};
const refused = (value: unknown) => {
  const read = momentOf(value);
  assert.ok('problem' in read, JSON.stringify(read));
  return read.problem;
};

test('a moment is kept as sent, with every kind', () => {
  assert.deepEqual(ok(WALK), WALK);
  assert.deepEqual(ok({ items: [{ kind: 'podcast', show: 'A Show' }] }), {
    items: [{ kind: 'podcast', show: 'A Show' }]
  });
  assert.deepEqual(ok({ items: [{ kind: 'played', title: 'A Tune' }] }), {
    items: [{ kind: 'played', title: 'A Tune' }]
  });
  assert.deepEqual(momentKinds(WALK), ['workout', 'song', 'steps', 'feeling', 'event', 'people', 'reflection']);
});

test('words are trimmed, empty ones left out, repeats once, numbers to tenths', () => {
  assert.deepEqual(
    ok({
      items: [
        { kind: 'song', title: '  A  Song\n', artist: '   ' },
        { kind: 'people', names: [' Ana ', 'Ana', '', 'Ben'] },
        { kind: 'workout', activity: 'other', name: ' Yoga ', duration_s: 1800.04, distance_m: 0 },
        { kind: 'event', title: 'Dinner', place: null }
      ]
    }),
    {
      items: [
        { kind: 'song', title: 'A Song' },
        { kind: 'people', names: ['Ana', 'Ben'] },
        { kind: 'workout', activity: 'other', name: 'Yoga', duration_s: 1800 },
        // Not hosting unless it says so.
        { kind: 'event', title: 'Dinner', hosted: false }
      ]
    }
  );
});

test('a moment is refused at the field that is wrong', () => {
  const cases: [unknown, string][] = [
    [null, 'moment'],
    [[], 'moment'],
    [{ items: [] }, 'moment.items'],
    [{ items: Array.from({ length: MOMENT_ITEMS + 1 }, () => ({ kind: 'steps', count: 1 })) }, 'moment.items'],
    [{ items: [{ kind: 'steps', count: 1 }], mood: 'x' }, 'moment.mood'],
    [{ at: 'yesterday', items: [{ kind: 'steps', count: 1 }] }, 'moment.at'],
    [{ items: ['walk'] }, 'moment.items[0]'],
    [{ items: [{ kind: 'dance' }] }, 'moment.items[0].kind'],
    [
      {
        items: [
          { kind: 'steps', count: 1 },
          { kind: 'workout', activity: 'walking', pace: 3 }
        ]
      },
      'moment.items[1].pace'
    ],
    [{ items: [{ kind: 'workout', activity: 'flying' }] }, 'moment.items[0].activity'],
    [{ items: [{ kind: 'workout', activity: 'running', distance_m: -1 }] }, 'moment.items[0].distance_m'],
    [{ items: [{ kind: 'workout', activity: 'running', distance_m: Infinity }] }, 'moment.items[0].distance_m'],
    [{ items: [{ kind: 'workout', activity: 'running', duration_s: '3600' }] }, 'moment.items[0].duration_s'],
    [{ items: [{ kind: 'steps', count: 0 }] }, 'moment.items[0].count'],
    [{ items: [{ kind: 'steps', count: 12.5 }] }, 'moment.items[0].count'],
    [{ items: [{ kind: 'steps', count: 10, movement: 'skipping' }] }, 'moment.items[0].movement'],
    [{ items: [{ kind: 'song' }] }, 'moment.items[0].title'],
    [{ items: [{ kind: 'song', title: 'x'.repeat(201) }] }, 'moment.items[0].title'],
    [{ items: [{ kind: 'feeling' }] }, 'moment.items[0].labels'],
    [{ items: [{ kind: 'feeling', valence: 'slightly pleasant' }] }, 'moment.items[0].valence'],
    [{ items: [{ kind: 'feeling', labels: 'calm' }] }, 'moment.items[0].labels'],
    [{ items: [{ kind: 'feeling', labels: [3] }] }, 'moment.items[0].labels[0]'],
    [{ items: [{ kind: 'event', title: ' ' }] }, 'moment.items[0].title'],
    [{ items: [{ kind: 'event', title: 'A', hosted: 'yes' }] }, 'moment.items[0].hosted'],
    [{ items: [{ kind: 'event', title: 'A', start: '2026-10-11' }] }, 'moment.items[0].start'],
    [{ items: [{ kind: 'people', names: [] }] }, 'moment.items[0].names'],
    [{ items: [{ kind: 'people', names: Array.from({ length: 21 }, (_, i) => `P${i}`) }] }, 'moment.items[0].names'],
    [{ items: [{ kind: 'reflection', prompt: 'x'.repeat(401) }] }, 'moment.items[0].prompt']
  ];
  for (const [value, field] of cases) {
    const problem = refused(value);
    assert.equal(problem.field, field, JSON.stringify(value));
    assert.ok(problem.detail.length > 0);
  }
  // What a stored moment can't be read as is nothing, never an error.
  assert.equal(storedMoment({ items: [{ kind: 'dance' }] }), null);
  assert.equal(storedMoment(undefined), null);
  assert.deepEqual(storedMoment(WALK), WALK);
});

test('each piece is one plain line, in the account’s units', () => {
  assert.deepEqual(momentParts(WALK, true), [
    { kind: 'workout', text: 'Walk · 3.2 mi · 48 min' },
    { kind: 'song', text: 'A Song · A Band' },
    { kind: 'steps', text: '8,214 steps' },
    { kind: 'feeling', text: 'Calm, grateful' },
    { kind: 'event', text: 'Picnic · The Park · hosted' },
    { kind: 'people', text: 'With Ana, Ben and Cy' },
    { kind: 'reflection', text: 'What made today good?' }
  ]);
  assert.equal(momentParts(WALK, false)[0]!.text, 'Walk · 5.2 km · 48 min');
  assert.deepEqual(
    momentParts(
      {
        items: [
          { kind: 'workout', activity: 'swimming', distance_m: 1000, duration_s: 3900 },
          { kind: 'workout', activity: 'other', name: 'Yoga', duration_s: 3600 },
          { kind: 'workout', activity: 'cycling', distance_m: 32000 },
          { kind: 'feeling', valence: 'slightly_pleasant' },
          { kind: 'people', names: ['Ana', 'Ben'] },
          { kind: 'podcast', episode: 'Episode 4' }
        ]
      },
      true
    ).map((p) => p.text),
    [
      'Swim · 1,094 yd · 1 hr 5 min',
      'Yoga · 1 hr',
      'Ride · 19.9 mi',
      'Slightly pleasant',
      'With Ana and Ben',
      'Episode 4'
    ]
  );
  assert.equal(distanceText(1000, true, false), '1,000 m');
  assert.equal(distanceText(3000, false, false), '3 km');
  assert.equal(distanceText(160_934.4, false, true), '100 mi');
  assert.equal(durationText(59), '1 min');
  assert.ok(usesMiles('United States') && usesMiles('United Kingdom'));
  assert.ok(!usesMiles('Switzerland') && !usesMiles(undefined));
});
