/** Count-only fictional census parity; no network, table, mail or private data. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { counts, line, report } from '../packages/backend/census.ts';
import type { Item } from '../packages/backend/store.ts';
import { addDays } from '../packages/domain/dates.ts';
const now = Date.parse('2026-10-09T15:00:00Z') / 1000;
const profile = (user: string, overrides: Item = {}): Item => ({
  pk: `USER#${user}`,
  sk: 'PROFILE',
  status: 'active',
  tz: 'America/Chicago',
  send_time: '06:00',
  last_sent_date: '2026-10-09',
  ...overrides
});
const note = (user: string, day: string, id = 'm1', overrides: Item = {}): Item => ({
  pk: `USER#${user}`,
  sk: `NOTE#${day}#${id}`,
  ...overrides
});
const sent = (user: string, day: string): Item => ({ pk: `USER#${user}`, sk: `DAY#${day}` });

test('subscriber state, pauses, local overdue grace and already sent semantics match Python', () => {
  const c = counts(
    [
      profile('a'),
      profile('b', { pause_from: '2026-10-08', pause_through: '2026-10-12' }),
      profile('c', { status: 'stopped' }),
      profile('d', { pause_from: '2026-09-01', pause_through: '2026-09-05' })
    ],
    now
  );
  assert.deepEqual([c.Subscribers, c.Paused, c.Stopped], [2, 1, 1]);
  const late = { last_sent_date: '2026-10-08' };
  assert.equal(
    counts(
      [
        profile('a', late),
        profile('b', { send_time: '09:30', ...late }),
        profile('c', { send_time: '11:00', ...late }),
        profile('d', { status: 'stopped', ...late }),
        profile('e', { pause_from: '2026-10-09', pause_through: '2026-10-09', ...late }),
        profile('f', { last_sent_date: null })
      ],
      now
    ).Overdue,
    2
  );
  assert.equal(counts([profile('a', { tz: 'Pacific/Auckland', last_sent_date: '2026-10-10' })], now).Overdue, 0);
  assert.equal(counts([profile('a', { send_time: '09:30', ...late })], now + 0.001).Overdue, 1);
});

test('every channel and orphan note counts, media empty arrays do not', () => {
  const c = counts(
    [
      profile('a'),
      note('a', '2026-10-09', 'm1', { media: [{ kind: 'image' }] }),
      note('a', '2026-10-09', 'w-1', { source: 'web', media: [] }),
      note('a', '2015-06-01', 'd1-1', { source: 'import' }),
      note('gone', '2026-01-01'),
      note('a', '2026-10-09', 'a-1', { source: 'agent' })
    ],
    now
  );
  assert.deepEqual(
    [c.Notes, c.EmailNotes, c.WebNotes, c.ImportedNotes, c.AgentNotes, c.NotesWithMedia],
    [5, 2, 1, 1, 1, 1]
  );
});

test('writer windows use local calendar days and count each subscriber once', () => {
  const c = counts(
    [
      profile('a'),
      note('a', '2026-10-03'),
      note('a', '2026-10-09', 'm2'),
      profile('b'),
      note('b', '2026-10-02'),
      profile('c'),
      note('c', '2026-09-09'),
      profile('d', { tz: 'Pacific/Auckland' }),
      note('d', '2026-10-04'),
      profile('e', { status: 'stopped' }),
      note('e', '2026-10-09')
    ],
    now
  );
  assert.deepEqual([c.Writers7, c.Writers30], [3, 4]);
});

test('reply rate excludes today and includes imports, deduplicating notes by emailed day', () => {
  const rows = [profile('a')];
  for (let day = 1; day <= 8; day++) rows.push(sent('a', `2026-10-0${day}`));
  rows.push(
    note('a', '2026-10-01', 'm1', { source: 'import' }),
    note('a', '2026-10-02', 'm2'),
    note('a', '2026-10-02', 'm3'),
    sent('a', '2026-10-09'),
    note('a', '2026-10-09'),
    sent('a', '2026-09-08'),
    note('a', '2026-09-08')
  );
  assert.equal(counts(rows, now).ReplyRate30, 25);
  assert.equal(counts([profile('a'), note('a', '2026-10-09')], now).ReplyRate30, undefined);
});

test('reply-rate exact half tenths preserve Python ties-to-even', () => {
  for (const [replies, expected] of [
    [1, 6.2],
    [3, 18.8]
  ] as const) {
    const rows = [profile('a')];
    for (let index = 1; index <= 16; index++) {
      const day = addDays('2026-10-09', -index);
      rows.push(sent('a', day));
      if (index <= replies) rows.push(note('a', day));
    }
    assert.equal(counts(rows, now).ReplyRate30, expected);
  }
});

test('EMF shape emits count/percent units and never copies input fields', async () => {
  const input = [
    profile('a', { email: 'ada@example.com' }),
    note('a', '2026-10-09', 'm1', { text: 'fictional private text' })
  ];
  const c = counts(input, now),
    metrics = line({ ...c, ReplyRate30: 50 }, now);
  assert.deepEqual(metrics._aws.CloudWatchMetrics[0]?.Dimensions, [[]]);
  assert.equal(metrics._aws.Timestamp, now * 1000);
  assert.equal(metrics._aws.CloudWatchMetrics[0]?.Namespace, 'ReleaseNotes');
  assert.ok(
    metrics._aws.CloudWatchMetrics[0]?.Metrics.every(
      (metric) => metric.Unit === (metric.Name === 'ReplyRate30' ? 'Percent' : 'Count')
    )
  );
  let output: unknown;
  await report({ censusItems: async () => input }, now, (value) => {
    output = value;
  });
  const encoded = JSON.stringify(output);
  assert.ok(!encoded.includes('ada@example.com'));
  assert.ok(!encoded.includes('fictional private text'));
  assert.ok(!encoded.includes('USER#'));
  assert.deepEqual(output, line(c, now));
});

test('census scan and invalid timezone failures propagate for sender to log safely', async () => {
  await assert.rejects(
    report(
      {
        censusItems: async () => {
          throw new Error('fictional scan failure');
        }
      },
      now
    )
  );
  assert.throws(() => counts([profile('a', { tz: 'fictional/zone' })], now));
});
