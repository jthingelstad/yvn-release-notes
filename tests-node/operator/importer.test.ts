import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import * as d from '../../packages/backend/dayone.ts';
import * as importer from '../../packages/backend/importer.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import type { Item } from '../../packages/backend/store.ts';
const A = 'A'.repeat(32),
  B = 'B'.repeat(32),
  profile = {
    birthday: '1981-06-14',
    tz: 'America/Chicago',
    city: 'Minneapolis',
    region: 'Minnesota',
    country: 'United States',
    lat: 44.98,
    lon: -93.26
  };
const harbor = {
  placeName: 'Town Pier',
  localityName: 'Bar Harbor',
  administrativeArea: 'Maine',
  country: 'United States',
  latitude: 44.391234,
  longitude: -68.204321
};
const entries = [
  {
    uuid: A,
    creationDate: '2016-07-05T01:40:00Z',
    timeZone: 'America/New_York',
    location: harbor,
    text: 'Fireworks over [the pier](https://pier.example/) and https://news.example/x',
    photos: [{ md5: 'p1', location: harbor }],
    tags: ['Maine 2016']
  },
  {
    uuid: B,
    creationDate: '2016-07-06T15:00:00Z',
    timeZone: 'America/New_York',
    text: 'Menu',
    pdfAttachments: [{ md5: 'f1', pdfName: 'Menu' }]
  }
];
const files: Record<string, Buffer> = {
  'photos/p1.jpeg': Buffer.from('jpeg-bytes'),
  'pdfs/f1.pdf': Buffer.from('%PDF-1.4')
};
const plan = (journal = 'Journal') =>
  d.plan(journal, entries, Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length])), profile, 'u1');
function setup() {
  const store = new FakeStore([{ pk: 'USER#u1', sk: 'PROFILE', ...profile }], 'T'),
    objects = new FakeObjects(),
    titles: string[] = [],
    skies: string[] = [];
  const s: importer.Services = {
    store,
    objects,
    today: '2026-10-09',
    at: '2026-10-09T12:00:00Z',
    fetchTitle: async (url) => {
      titles.push(url);
      return { title: 'A page', site: 'news.example' };
    },
    fetchWeather: async (url) => {
      skies.push(url);
      const day = new URL(url).searchParams.get('start_date');
      return { daily: { time: [day], temperature_2m_max: [24], temperature_2m_min: [15.5], weather_code: [1] } };
    }
  };
  return { store, objects, s, titles, skies };
}
const run = (s: importer.Services, p = plan()) => importer.write([[p, (name) => files[name]!]], 'u1', s);
test('fictional legacy import writes files/originals/note links/weather with native numbers and tags', async () => {
  const { s, store, objects, titles, skies } = setup(),
    counts = await run(s);
  assert.deepEqual(
    Object.fromEntries(
      ['notes', 'files', 'originals', 'links_named', 'links_titled', 'weather_kept'].map((k) => [k, counts[k]])
    ),
    { notes: 2, files: 2, originals: 2, links_named: 1, links_titled: 1, weather_kept: 2 }
  );
  const note = (await store.note('u1', '2016-07-04', `d1-${A}`))!;
  assert.deepEqual(note.links, [
    { url: 'https://pier.example/', title: 'the pier', named: true },
    { url: 'https://news.example/x', title: 'A page', site: 'news.example' }
  ]);
  assert.deepEqual(titles, ['https://news.example/x']);
  assert.deepEqual(await store.imported('u1', 'IMPORT#dayone#journal'), new Set([A, B]));
  const raw = String(note.raw_key);
  assert.equal(JSON.parse((await objects.get(raw)).body.toString()).uuid, A);
  assert.deepEqual(await objects.tags(raw), { outcome: 'note' });
  const media = (note.media as Item[])[0]!;
  assert.equal((await objects.get(String(media.key))).type, 'image/jpeg');
  assert.deepEqual(await objects.tags(String(media.key)), { outcome: 'note' });
  assert.equal((await store.weatherBetween('u1', '2016-07-04', '2016-07-04'))['2016-07-04']?.lat, 44.39);
  assert.ok(skies[0]!.includes('latitude=44.39&longitude=-68.2'));
  // One activity row for the run: its counts, never a journal, words or file.
  const rows = await store.activityAll('u1', Date.parse(s.at) / 1000);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.at, r.via, r.app, r.notes, r.files]),
    [['import.notes', '2026-10-09T12:00:00.000Z', 'import', 'dayone', 2, 2]]
  );
});
test('a run that stops partway records the notes it committed, and its retry the rest', async () => {
  const { s, store } = setup(),
    rows = async () =>
      (await store.activityAll('u1', Date.parse(s.at) / 1000)).map((r) => [r.kind, r.at, r.notes, r.files]);
  // The second note's file cannot be read: the first note stays imported.
  await assert.rejects(
    () =>
      importer.write(
        [
          [
            plan(),
            (name) => {
              if (name === 'pdfs/f1.pdf') throw new Error('unreadable');
              return files[name]!;
            }
          ]
        ],
        'u1',
        s
      ),
    /Import write failed/
  );
  assert.deepEqual(await rows(), [['import.notes', '2026-10-09T12:00:00.000Z', 1, 1]]);
  const counts = await run({ ...s, at: '2026-10-09T12:05:00Z' });
  assert.deepEqual([counts.notes, counts.already_imported], [1, 1]);
  assert.deepEqual(await rows(), [
    ['import.notes', '2026-10-09T12:05:00.000Z', 1, 1],
    ['import.notes', '2026-10-09T12:00:00.000Z', 1, 1]
  ]);
});
test('repeat skips every upload; deleted note stays deleted even across journals or changed entry zone', async () => {
  const { s, store, objects } = setup();
  await run(s);
  await store.deleteNote('u1', '2016-07-06', `d1-${B}`);
  objects.calls.length = 0;
  const counts = await run(s);
  assert.equal(counts.notes, 0);
  assert.equal(counts.already_imported, 2);
  assert.equal(objects.calls.length, 0);
  // A run with nothing new adds no row.
  assert.equal((await store.activityAll('u1', Date.parse(s.at) / 1000)).length, 1);
  assert.equal(await store.note('u1', '2016-07-06', `d1-${B}`), null);
  const p = plan('Gratitude');
  const changed = await run(s, p);
  assert.equal(changed.notes, 0);
  assert.equal(changed.already_imported, 2);
  assert.equal(await store.note('u1', '2016-07-06', `d1-${B}`), null);
  assert.equal(importer.ledger(p), 'IMPORT#dayone#gratitude');
});
test('existing id on another day skips objects and kept/current/future weather stays unchanged', async () => {
  const { s, store } = setup();
  await store.putNote('u1', '2016-07-05', `d1-${A}`, { text: 'Moved by a zone change' });
  await store.putWeather('u1', '2016-07-04', { code: 3, city: 'Minneapolis' });
  const counts = await run(s);
  assert.equal(counts.notes, 1);
  assert.equal(counts.id_taken, 1);
  assert.equal(await store.note('u1', '2016-07-04', `d1-${A}`), null);
  assert.equal((await store.weatherBetween('u1', '2016-07-04', '2016-07-04'))['2016-07-04']?.city, 'Minneapolis');
});
test('atomic import exact SDK request commits note and native set ledger with account proof', async () => {
  const { store } = setup();
  assert.equal(
    await store.putImportedNote('u1', '2016-07-04', `d1-${A}`, { text: 'fiction' }, 'IMPORT#dayone#journal', A, 'at'),
    true
  );
  const input = store.memory.calls.find((c) => c.name === 'TransactWriteCommand')!.input as InstanceType<
    typeof TransactWriteCommand
  >['input'];
  assert.deepEqual(input, {
    TransactItems: [
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'USER#u1', sk: 'PROFILE' },
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'
        }
      },
      {
        Put: {
          TableName: 'T',
          Item: { pk: 'USER#u1', sk: `NOTE#2016-07-04#d1-${A}`, text: 'fiction' },
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      },
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'USER#u1', sk: 'IMPORT#dayone#journal' },
          UpdateExpression: 'ADD ids :ids SET updated_at = :at',
          ConditionExpression: 'attribute_not_exists(ids) OR NOT contains(ids, :id)',
          ExpressionAttributeValues: { ':ids': new Set([A]), ':id': A, ':at': 'at' }
        }
      }
    ]
  });
  await store.deleteNote('u1', '2016-07-04', `d1-${A}`);
  assert.equal(
    await store.putImportedNote('u1', '2016-07-04', `d1-${A}`, { text: 'revive' }, 'IMPORT#dayone#journal', A, 'at'),
    false
  );
  assert.equal(await store.note('u1', '2016-07-04', `d1-${A}`), null);
});
test('account deletion during staged import refuses note/ledger and removes staged files/raw', async () => {
  const { s, store, objects } = setup();
  let blocked = false;
  store.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand && !blocked) {
      blocked = true;
      store.seed({ pk: 'USER#u1', sk: 'PROFILE', ...profile, mcp_deleting: true });
    }
  };
  await assert.rejects(() => run(s), { message: 'Import account unavailable' });
  assert.equal((await store.allNotes('u1')).length, 0);
  assert.equal((await store.imported('u1', 'IMPORT#dayone#journal')).size, 0);
  assert.deepEqual(await objects.list('media/'), []);
  assert.deepEqual(await objects.list('raw/'), []);
});
test('missing-file plan refuses before any reads/writes; failed staged upload cleans prior copies', async () => {
  const { s, objects } = setup();
  await assert.rejects(() => run(s, { ...plan(), missing_files: 1 }), {
    message: 'Import refused: missing export files'
  });
  assert.equal(objects.calls.length, 0);
  const p = plan();
  const original = objects.put.bind(objects);
  objects.put = async (key, body, options) => {
    if (key.startsWith('raw/')) throw new Error('private detail');
    return original(key, body, options);
  };
  await assert.rejects(() => run(s, p), { message: 'Import write failed' });
  assert.deepEqual(await objects.list('media/'), []);
});

test('even a final single-note import reports a concurrent account deletion after staged cleanup', async () => {
  const { s, store, objects } = setup(),
    single = plan();
  single.notes = single.notes.slice(0, 1);
  s.fetchWeather = undefined;
  store.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand)
      store.seed({ pk: 'USER#u1', sk: 'PROFILE', ...profile, mcp_deleting: true });
  };
  await assert.rejects(() => run(s, single), { message: 'Import account unavailable' });
  assert.deepEqual(await objects.list('media/'), []);
  assert.deepEqual(await objects.list('raw/'), []);
  assert.equal((await store.allNotes('u1')).length, 0);
});
test('overlapping imports with different bytes keep winner references immutable and clean only loser staging', async () => {
  const { store, objects, s } = setup(),
    winningBytes = Buffer.from('fictional winning photo'),
    losingBytes = Buffer.from('fictional different losing photo'),
    make = (text: string, body: Buffer) =>
      d.plan('Journal', [{ ...entries[0], text }], { 'photos/p1.jpeg': body.length }, profile, 'u1'),
    winning = make('Winning original JSON', winningBytes),
    losing = make('Losing original JSON', losingBytes),
    originalPlans = structuredClone([winning, losing]);
  s.fetchWeather = undefined;
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    proceed = new Promise<void>((resolve) => {
      resume = resolve;
    });
  // Both attempts observe the absent note/ledger. Pause the future loser before
  // its upload, let the winner commit, then let stale loser uploads proceed.
  const loser = importer.write(
    [
      [
        losing,
        async () => {
          entered();
          await proceed;
          return losingBytes;
        }
      ]
    ],
    'u1',
    s
  );
  await waiting;
  const winner = await importer.write([[winning, () => winningBytes]], 'u1', s),
    storedBefore = (await store.note('u1', '2016-07-04', `d1-${A}`))!,
    winnerRaw = String(storedBefore.raw_key),
    winnerMedia = String((storedBefore.media as Item[])[0]!.key);
  resume();
  const lost = await loser,
    storedAfter = (await store.note('u1', '2016-07-04', `d1-${A}`))!;
  assert.equal(winner.notes, 1);
  assert.equal(lost.notes, 0);
  assert.equal(lost.id_taken, 1);
  assert.deepEqual(storedAfter, storedBefore);
  assert.equal((await objects.get(winnerMedia)).body.equals(winningBytes), true);
  assert.equal(
    (await objects.get(winnerRaw)).body.equals(Buffer.from(JSON.stringify(winning.notes[0]!.original, null, 1))),
    true
  );
  assert.equal(objects.versions.get(winnerMedia)?.length, 1);
  assert.equal(objects.versions.get(winnerRaw)?.length, 1);
  assert.notEqual(winnerRaw, winning.notes[0]!.item.raw_key);
  assert.notEqual(winnerMedia, (winning.notes[0]!.item.media as Item[])[0]!.key);
  assert.deepEqual(await store.imported('u1', 'IMPORT#dayone#journal'), new Set([A]));
  const puts = objects.calls.filter((c) => c.operation === 'put').map((c) => c.key),
    removed = objects.calls.filter((c) => c.operation === 'remove').map((c) => c.key),
    losers = puts.filter((key) => key !== winnerRaw && key !== winnerMedia);
  assert.equal(new Set(puts).size, 4);
  assert.equal(losers.length, 2);
  assert.deepEqual(new Set(removed), new Set(losers));
  assert.deepEqual(await objects.list('media/'), [winnerMedia]);
  assert.deepEqual(await objects.list('raw/'), [winnerRaw]);
  assert.deepEqual(await objects.tags(winnerMedia), { outcome: 'note' });
  assert.deepEqual(await objects.tags(winnerRaw), { outcome: 'note' });
  assert.deepEqual([winning, losing], originalPlans);
});
