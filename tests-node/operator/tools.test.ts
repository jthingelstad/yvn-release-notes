import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { STSClient } from '@aws-sdk/client-sts';
import { FakeStore } from '../../packages/testing/store.ts';
import { argumentsFor, writing, assertWriter, ACCOUNT } from '../../tools/operator.ts';
import { report as subscribers } from '../../tools/subscribers.ts';
import { report as tally } from '../../tools/tally.ts';
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
test('tally contains aggregate months only', async () => {
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
  assert.equal(hasWrites(store), false);
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
