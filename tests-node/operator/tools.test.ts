import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { STSClient } from '@aws-sdk/client-sts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { argumentsFor, writing, assertWriter, ACCOUNT } from '../../tools/operator.ts';
import { report as subscribers } from '../../tools/subscribers.ts';
import { report as tally } from '../../tools/tally.ts';
import { report as readNotes } from '../../tools/read-notes.ts';
import { fill as fillLinks } from '../../tools/fill-link-titles.ts';
import { fill as fillWeather } from '../../tools/fill-weather.ts';
import { extract, extractAll } from '../../tools/extract-media.ts';
import { baseline } from '../../tools/badges-baseline.ts';
import { privatePlanDirectory, savePlans, report, sampleWeather } from '../../tools/import-dayone.ts';
import { plan } from '../../packages/backend/dayone.ts';
const p = {
  pk: 'USER#u',
  sk: 'PROFILE',
  email: 'ada@example.com',
  birthday: '1981-06-14',
  tz: 'UTC',
  city: 'Example City',
  lat: 44,
  lon: -93,
  status: 'active',
  created_at: '2026-10-01T00:00:00Z'
};
const now = Date.parse('2026-10-13T00:00:00Z') / 1000;
const note = (id = 'n') => ({
  pk: p.pk,
  sk: `NOTE#2026-10-10#${id}`,
  text: 'A fictional entry https://page.example/',
  version: '4.5.118',
  received_at: '2026-10-10T00:00:00Z'
});
const hasWrites = (s: FakeStore) =>
  s.memory.calls.some((c) => /Put|Update|Delete|TransactWrite|BatchWrite/.test(c.name));
const planned = () =>
  plan(
    'Journal',
    [
      {
        uuid: 'A'.repeat(32),
        creationDate: '2016-07-05T01:40:00Z',
        timeZone: 'UTC',
        text: 'Private fictional words #travel',
        location: { localityName: 'Hidden City', latitude: 44, longitude: -93 }
      }
    ],
    {},
    p,
    'u'
  );
test('operator write gates are explicit and check account plus narrow role', async () => {
  assert.equal(writing(argumentsFor(['ada@example.com']).values), false);
  assert.equal(writing(argumentsFor(['--dry-run']).values), false);
  assert.equal(writing(argumentsFor(['--write']).values), true);
  assert.throws(() => writing(argumentsFor(['--write', '--dry-run']).values));
  const client = (Account: string, Arn: string) => ({ send: async () => ({ Account, Arn }) }) as unknown as STSClient;
  await assertWriter(client(ACCOUNT, `arn:aws:sts::${ACCOUNT}:assumed-role/ProjectsCloudEngineer/test`));
  await assert.rejects(() =>
    assertWriter(client('000000000000', `arn:aws:sts::${ACCOUNT}:assumed-role/ProjectsCloudEngineer/test`))
  );
  await assert.rejects(() => assertWriter(client(ACCOUNT, `arn:aws:sts::${ACCOUNT}:assumed-role/Other/test`)));
});
test('subscriber rows project only safe fields, paginate, and preserve Python half-even percentages', async () => {
  const store = new FakeStore(
    [
      p,
      note(),
      ...Array.from({ length: 8 }, (_, i) => ({ pk: p.pk, sk: `DAY#2026-10-${String(i + 3).padStart(2, '0')}` }))
    ],
    'T',
    2
  );
  const text = await subscribers(store, now);
  assert.ok(text.includes('ada@example.com'));
  assert.ok(text.includes('12%'));
  assert.ok(!text.includes('fictional entry'));
  const calls = store.memory.calls.filter((c) => c.name === 'ScanCommand');
  assert.ok(calls.length > 1);
  for (const c of calls) {
    const input = c.input as { ProjectionExpression: string };
    assert.ok(!/text|raw_key|inbox_token|reply_token|links/.test(input.ProjectionExpression));
  }
  assert.equal(hasWrites(store), false);
});
test('tally contains aggregate months only; manual note report orders by writing time rather than key', async () => {
  const store = new FakeStore(
    [
      p,
      { pk: 'TALLY#2026-10', sk: 'COUNTS', signups: 4 },
      { ...note('a'), text: 'Second', written_at: '2026-10-10T03:00:00Z' },
      { ...note('z'), text: 'First', written_at: '2026-10-10T01:00:00Z' }
    ],
    'T',
    1
  );
  const counts = await tally(store);
  assert.ok(counts.includes('2026-10'));
  assert.ok(!counts.includes('ada@example.com'));
  const words = await readNotes(store, 'u', '2026-10-10');
  assert.ok(words.indexOf('First') < words.indexOf('Second'));
  assert.ok(words.includes('2 replies'));
  await assert.rejects(() => readNotes(store, 'u', 'bad'));
  assert.equal(hasWrites(store), false);
});
test('link fill dry run fetches only injected titles; changed words and deleting profile prevent writes', async () => {
  const store = new FakeStore([p, note()]),
    fetcher = async () => ({ title: 'A page', site: 'page.example' });
  const dry = await fillLinks(store, 'u', false, fetcher);
  assert.equal(dry.named, 1);
  assert.equal(hasWrites(store), false);
  store.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand) store.seed({ ...note(), text: 'Changed' });
  };
  assert.equal((await fillLinks(store, 'u', true, fetcher)).changed, 1);
  assert.equal((await store.note('u', '2026-10-10', 'n'))?.links, undefined);
  store.memory.beforeSend = undefined;
  store.seed(note());
  store.seed({ ...p, mcp_deleting: true });
  assert.equal((await fillLinks(store, 'u', true, fetcher)).changed, 1);
  assert.equal((await store.note('u', '2026-10-10', 'n'))?.links, undefined);
});
test('weather fill skips current/future/existing days and proves account before keeping results', async () => {
  const store = new FakeStore([
    p,
    note(),
    { ...note('today'), sk: 'NOTE#2026-10-13#today' },
    { ...note('future'), sk: 'NOTE#2026-10-14#future' }
  ]);
  let fetched = 0;
  const fetcher = async (url: string) => {
    fetched++;
    const day = new URL(url).searchParams.get('start_date');
    return { daily: { time: [day], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [1] } };
  };
  assert.equal((await fillWeather(store, 'u', false, fetcher, now, 0)).kept, 1);
  assert.equal(fetched, 1);
  assert.equal(hasWrites(store), false);
  store.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand) store.seed({ ...p, mcp_deleting: true });
  };
  assert.equal((await fillWeather(store, 'u', true, fetcher, now, 0)).changed, 1);
  assert.deepEqual(await store.weatherBetween('u', '2026-10-10', '2026-10-10'), {});
});
const audio = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(4000)]);
const raw = Buffer.from(
  [
    'From: ada@example.com',
    'To: reply@example.com',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="X"',
    '',
    '--X',
    'Content-Type: text/plain',
    '',
    'Fictional text',
    '--X',
    'Content-Type: audio/wav',
    'Content-Disposition: attachment; filename="voice.wav"',
    'Content-Transfer-Encoding: base64',
    '',
    audio.toString('base64'),
    '--X--',
    ''
  ].join('\r\n')
);
test('badges baseline counts only, writes only with --write, repeats harmlessly and skips deleting accounts', async () => {
  const store = new FakeStore([p, { ...p, pk: 'USER#v', email: 'grace@example.com' }]);
  await store.putNote('u', '2026-10-10', 'w-a', {
    text: 'A fictional entry',
    source: 'web',
    written_at: '2026-10-10T12:00:00Z'
  });
  store.memory.calls.length = 0;
  const dry = await baseline(store, false, now);
  assert.deepEqual(dry, {
    dry_run: true,
    subscribers: 2,
    skipped: 0,
    earning: 1,
    earned: 3,
    already_seen: 0,
    to_add: 3,
    written: 0,
    gone: 0
  });
  assert.equal(hasWrites(store), false);
  assert.ok(!JSON.stringify(dry).includes('ada'));
  assert.equal((await baseline(store, true, now)).written, 1);
  assert.deepEqual(await store.seenBadges('u'), new Set(['hello', 'web', 'commit']));
  assert.deepEqual(await store.seenBadges('v'), new Set());
  const again = await baseline(store, true, now);
  assert.deepEqual([again.already_seen, again.to_add, again.written], [3, 0, 0]);
  store.seed({ ...p, mcp_deleting: true });
  assert.equal((await baseline(store, false, now)).skipped, 1);
});
test('badges baseline --only marks just the named badges seen', async () => {
  const store = new FakeStore([p]);
  await store.putNote('u', '2026-10-10', 'w-a', {
    text: 'A fictional entry',
    source: 'web',
    written_at: '2026-10-10T12:00:00Z'
  });
  store.memory.calls.length = 0;
  const dry = await baseline(store, false, now, new Set(['web', 'patches']));
  assert.deepEqual([dry.earned, dry.to_add, dry.written], [1, 1, 0]);
  assert.equal(hasWrites(store), false);
  assert.equal((await baseline(store, true, now, new Set(['web', 'patches']))).written, 1);
  assert.deepEqual(await store.seenBadges('u'), new Set(['web']));
});
test('media backfill dry run leaves raw untouched; deletion guard cleans staged files only', async () => {
  const store = new FakeStore([p, { ...note(), raw_key: 'raw/m1', attachments: [{ filename: 'voice.wav' }] }]),
    objects = new FakeObjects();
  await objects.put('raw/m1', raw, { type: 'message/rfc822', tags: { outcome: 'note' } });
  objects.calls.length = 0;
  assert.equal((await extract(store, objects, 'u')).files, 1);
  assert.deepEqual(
    objects.calls.map((c) => c.operation),
    ['get']
  );
  store.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand) store.seed({ ...p, mcp_deleting: true });
  };
  const result = await extract(store, objects, 'u', true);
  assert.equal(result.files, 0);
  assert.equal((await store.note('u', '2026-10-10', 'n'))?.media, undefined);
  assert.deepEqual(await objects.list('media/'), []);
  assert.equal((await objects.get('raw/m1')).body.equals(raw), true);
  assert.ok(!objects.calls.some((c) => c.operation === 'remove' && c.key === 'raw/m1'));
});
test('successful media backfill tags references note and repeats without replacing files', async () => {
  const store = new FakeStore([p, { ...note(), raw_key: 'raw/m1', attachments: [{}] }]),
    objects = new FakeObjects();
  await objects.put('raw/m1', raw, { type: 'message/rfc822' });
  assert.equal((await extract(store, objects, 'u', true)).files, 1);
  const key = (await objects.list('media/'))[0]!;
  assert.deepEqual(await objects.tags(key), { outcome: 'note' });
  objects.calls.length = 0;
  assert.equal((await extract(store, objects, 'u', true)).already_done, 1);
  assert.deepEqual(objects.calls, []);
});
const withPdf = Buffer.from(
  raw
    .toString()
    .replace(
      '--X--',
      [
        '--X',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="menu.pdf"',
        '',
        '%PDF-1.4 fictional menu',
        '--X--'
      ].join('\r\n')
    )
);
const voiceKept = {
  n: 1,
  kind: 'audio',
  type: 'audio/wav',
  size: 4012,
  key: 'media/u/2026-10-10/n/1.wav'
};
const pdfNote = (extra: Record<string, unknown> = {}) => ({
  ...note(),
  raw_key: 'raw/m1',
  attachments: [
    { filename: 'voice.wav', content_type: 'audio/wav' },
    { filename: 'menu.pdf', content_type: 'application/pdf' }
  ],
  ...extra
});
test('media backfill appends an emailed PDF to a note that already has media, once', async () => {
  const store = new FakeStore([p, pdfNote({ media: [voiceKept] })]),
    objects = new FakeObjects();
  await objects.put('raw/m1', withPdf, { type: 'message/rfc822' });
  const dry = await extract(store, objects, 'u');
  assert.deepEqual([dry.notes_filled, dry.files, dry.pdfs, dry.already_done], [1, 1, 1, 0]);
  assert.deepEqual(await objects.list('media/'), []);
  const done = await extract(store, objects, 'u', true);
  assert.deepEqual([done.notes_filled, done.pdfs], [1, 1]);
  const saved = (await store.note('u', '2026-10-10', 'n'))?.media as Record<string, unknown>[];
  assert.deepEqual(saved, [
    voiceKept,
    {
      n: 2,
      kind: 'file',
      type: 'application/pdf',
      size: 23,
      key: 'media/u/2026-10-10/n/2.pdf',
      name: 'menu.pdf'
    }
  ]);
  assert.deepEqual(await objects.tags('media/u/2026-10-10/n/2.pdf'), { outcome: 'note' });
  objects.calls.length = 0;
  assert.equal((await extract(store, objects, 'u', true)).already_done, 1);
  assert.deepEqual(objects.calls, []);
});
test('media backfill leaves a web-added PDF alone and loses a race without touching the note', async () => {
  const web = { n: 2, kind: 'file', type: 'application/pdf', size: 5, key: 'media/u/files/f1.pdf', name: 'x.pdf' };
  const store = new FakeStore([p, pdfNote({ media: [voiceKept, web] })]),
    objects = new FakeObjects();
  await objects.put('raw/m1', withPdf, { type: 'message/rfc822' });
  assert.equal((await extract(store, objects, 'u')).pdfs, 1);
  store.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand)
      store.seed(pdfNote({ media: [voiceKept, web, { ...web, n: 3, key: 'media/u/files/f2.pdf' }] }));
  };
  const lost = await extract(store, objects, 'u', true);
  assert.deepEqual([lost.notes_filled, lost.files, lost.pdfs], [0, 0, 0]);
  assert.equal(((await store.note('u', '2026-10-10', 'n'))?.media as unknown[] | undefined)?.length, 3);
  assert.deepEqual(await objects.list('media/'), []);
});
test('media backfill --all sums every subscriber and skips deleting accounts', async () => {
  const q = { ...p, pk: 'USER#v', email: 'grace@example.com' },
    gone = { ...p, pk: 'USER#w', email: 'hopper@example.com', mcp_deleting: true };
  const store = new FakeStore([p, q, gone, pdfNote({ media: [voiceKept] }), { ...pdfNote(), pk: q.pk }]),
    objects = new FakeObjects();
  await objects.put('raw/m1', withPdf, { type: 'message/rfc822' });
  const all = await extractAll(store, objects);
  assert.deepEqual(
    [all.subscribers, all.skipped, all.notes_filled, all.files, all.pdfs, all.dry_run],
    [3, 1, 2, 3, 2, true]
  );
  assert.equal(hasWrites(store), false);
  assert.ok(!JSON.stringify(all).includes('@'));
});
test('Day One report and bounded weather sampling expose counts only and never write', async () => {
  const store = new FakeStore([p]),
    plans = [planned()],
    result = JSON.stringify(await report(plans, store, 'u', '2026-10-13'));
  for (const secret of [
    'Private fictional words',
    'travel',
    'Hidden City',
    'ada@example.com',
    'raw/dayone/',
    'A'.repeat(32)
  ])
    assert.ok(!result.includes(secret));
  let calls = 0;
  assert.deepEqual(
    await sampleWeather(
      plans,
      store,
      'u',
      '2026-10-13',
      2,
      async (url) => {
        calls++;
        const day = new URL(url).searchParams.get('start_date');
        return { daily: { time: [day], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [0] } };
      },
      0
    ),
    { sampled: 1, answered: 1 }
  );
  assert.equal(calls, 1);
  assert.equal(hasWrites(store), false);
  await assert.rejects(() => sampleWeather(plans, store, 'u', '2026-10-13', -1));
});
test('private full plans require outside-Git 0700 directories and exclusive 0600 files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yvn-private-plan-'));
  try {
    const repo = join(root, 'repo');
    await mkdir(repo);
    await mkdir(join(repo, '.git'));
    await assert.rejects(() => privatePlanDirectory(join(repo, 'private')), /outside Git/);
    const open = join(root, 'open');
    await mkdir(open, { mode: 0o755 });
    await assert.rejects(() => privatePlanDirectory(open), /private directory/);
    const dir = join(root, 'plans');
    await savePlans([planned()], dir);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    const path = join(dir, 'plan-journal.json');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok((await readFile(path, 'utf8')).includes('Private fictional words'));
    await assert.rejects(() => savePlans([planned()], dir));
    const link = join(root, 'linked');
    await symlink(dir, link);
    await assert.rejects(() => privatePlanDirectory(link), /without symlinks/);
    await assert.rejects(() => savePlans([planned(), planned()], join(root, 'collision')), /filenames collide/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
