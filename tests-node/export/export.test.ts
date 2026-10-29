import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fromBuffer } from 'yauzl';
import {
  build,
  markdown,
  filePaths,
  photoFile,
  type ExportData,
  type FilePaths
} from '../../packages/backend/export.ts';
import { run } from '../../workers/export.ts';
import { combine } from '../../packages/domain/notes.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import type { Item } from '../../packages/backend/store.ts';
import type { Log } from '../../packages/backend/services.ts';
const fixtures = JSON.parse(await readFile(new URL('./fixtures/legacy.json', import.meta.url), 'utf8')) as Array<{
  items: Item[];
  with_files: boolean;
  files: FilePaths;
  data: ExportData;
  markdown: string;
}>;
test('JSON and Markdown owner exports match 16 independent Python goldens', () => {
  for (const f of fixtures) {
    const files = f.with_files ? filePaths(f.items) : undefined;
    if (f.with_files) assert.deepEqual(files, f.files);
    // Badges came after Python; their own test below covers them.
    const { badges, ...data } = build(f.items, '2026-10-13T07:00:00Z', files);
    assert.ok(badges === undefined || badges.length > 0);
    assert.deepEqual(data, f.data);
    assert.equal(markdown(data), f.markdown);
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes('private-'));
    assert.ok(!serialized.includes('media/u1/'));
  }
});
test('export file paths reject foreign owner keys and sanitize path extensions', () => {
  const files = filePaths(
    [
      {
        sk: 'NOTE#2026-10-12#a',
        media: [
          { key: 'media/u2/a.jpg', type: 'image/jpeg', kind: 'image' },
          { key: 'media/u1/a.x/../other', type: 'image/jpeg', kind: 'image' }
        ]
      }
    ],
    'u1'
  );
  assert.deepEqual(
    files.a?.map((f) => f.path),
    ['files/2026-10-12-1.jpg']
  );
});
async function setup() {
  const store = new FakeStore(),
    objects = new FakeObjects(),
    now = Date.parse('2026-10-13T07:00:00Z') / 1000;
  await store.createSubscriber('u1', 'ada@example.com', {
    birthday: '1981-06-14',
    tz: 'America/Chicago',
    status: 'active'
  });
  await store.putNote('u1', '2026-10-12', 'w-a', {
    text: 'Lake day.',
    source: 'web',
    written_at: '2026-10-12T20:00:00Z',
    media: [
      { n: 1, kind: 'image', type: 'image/jpeg', key: 'media/u1/files/a.jpg', size: 5 },
      { n: 2, kind: 'audio', type: 'audio/mp4', key: 'media/u1/files/missing.m4a', size: 5 }
    ]
  });
  await objects.put('media/u1/files/a.jpg', Buffer.from('photo'), { type: 'image/jpeg' });
  await store.startExport('u1', 'build-a', now, now + 960);
  return { store, objects, now, clock: () => now, log: (() => undefined) as Log };
}
function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) =>
    fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error);
        return;
      }
      const entries = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        })
      );
      zip.readEntry();
    })
  );
}
test('disk zip contains complete data and original files; missing files remain counted only', async () => {
  const context = await setup();
  assert.equal(await run(context, 'u1', 'build-a'), 'ready');
  const row = await context.store.export('u1');
  assert.equal(row?.files, 1);
  assert.equal(row?.expires_at, context.now + 86400);
  const zip = await unzip((await context.objects.get(String(row?.export_key))).body),
    prefix = 'release-notes-2026-10-13/';
  assert.deepEqual([...zip.keys()].sort(), [
    prefix + 'files/2026-10-12-1.jpg',
    prefix + 'release-notes.json',
    prefix + 'release-notes.md'
  ]);
  assert.equal(zip.get(prefix + 'files/2026-10-12-1.jpg')?.toString(), 'photo');
  assert.match(zip.get(prefix + 'release-notes.md')!.toString(), /Lake day\./);
  assert.ok(
    !zip
      .get(prefix + 'release-notes.json')!
      .toString()
      .includes('media/u1')
  );
});
test('the zip carries the profile photo as profile-photo.jpg, named in both files without its key', async () => {
  const context = await setup();
  await context.store.setPhoto(
    'u1',
    { key: 'media/u1/profile/p.jpg', at: '2026-10-12T21:00:00.000Z', size: 4, side: 512 },
    null
  );
  await context.objects.put('media/u1/profile/p.jpg', Buffer.from('face'), { type: 'image/jpeg' });
  assert.equal(await run(context, 'u1', 'build-a'), 'ready');
  const row = await context.store.export('u1'),
    zip = await unzip((await context.objects.get(String(row?.export_key))).body),
    prefix = 'release-notes-2026-10-13/',
    json = JSON.parse(zip.get(prefix + 'release-notes.json')!.toString()) as ExportData;
  assert.equal(row?.files, 2);
  assert.equal(zip.get(prefix + 'profile-photo.jpg')?.toString(), 'face');
  assert.deepEqual(json.profile.photo, { path: 'profile-photo.jpg', set_at: '2026-10-12T21:00:00.000Z' });
  assert.match(zip.get(prefix + 'release-notes.md')!.toString(), /!\[Profile photo\]\(profile-photo\.jpg\)/);
  assert.ok(
    !zip
      .get(prefix + 'release-notes.json')!
      .toString()
      .includes('media/u1')
  );
  // The words alone name no file; another owner's key is never exported.
  assert.equal(build(await context.store.userItems('u1'), 'now').profile.photo, undefined);
  context.store.seed({ ...(await context.store.profile('u1'))!, photo: { key: 'media/u2/profile/p.jpg' } });
  assert.equal(photoFile(await context.store.userItems('u1'), 'u1'), null);
});
test('both exports carry badges, oldest first, worked out from the rows at export time', async () => {
  const context = await setup();
  assert.equal(await run(context, 'u1', 'build-a'), 'ready');
  const row = await context.store.export('u1'),
    zip = await unzip((await context.objects.get(String(row?.export_key))).body),
    prefix = 'release-notes-2026-10-13/',
    data = JSON.parse(zip.get(prefix + 'release-notes.json')!.toString()) as ExportData,
    md = zip.get(prefix + 'release-notes.md')!.toString();
  assert.deepEqual(
    data.badges?.map((b) => b.id),
    ['hello', 'web', 'assets', 'audio', 'commit', 'fullstack']
  );
  assert.deepEqual(data.badges?.[0], {
    id: 'hello',
    name: 'Hello, world',
    line: 'Your first note.',
    version: '4.5.120',
    day: '2026-10-12',
    earned: '2026-10-12'
  });
  assert.match(
    md,
    /\n## Badges\n\n6 badges, each with the version it was earned on\.\n\n- 4\.5\.120: Hello, world\. Your first note\.\n/
  );
  assert.ok(md.indexOf('## Badges') < md.indexOf('Lake day'));
  // No notes, no badges.
  assert.equal(
    build([{ sk: 'PROFILE', birthday: '1981-06-14', tz: 'America/Chicago' }], '2026-10-13T07:00:00Z').badges,
    undefined
  );
});
test('the JSON carries the activity log oldest first, with the reads and live old mail rows, never table keys', async () => {
  const context = await setup(),
    at = (t: string) => `2026-10-${t}:00:00.000Z`;
  await context.store.recordMail('u1', `ACTIVITY#${at('12T15')}#mail#m2`, {
    kind: 'mail',
    at: at('12T15'),
    message: 'm2',
    received_at: at('12T15'),
    via: 'reply',
    outcome: 'not-filed',
    reason: 'expired',
    text: 'Late words',
    notified_at: at('12T15')
  });
  context.store.seed({
    pk: 'MCPMETA#u1',
    sk: `ACTIVITY#${at('12T05')}#reads#f`,
    kind: 'reads',
    at: at('12T05'),
    day: '2026-10-12',
    client: 'Claude',
    connection: 'f',
    calls: 4,
    tools: { notes_list: 4 },
    last_at: at('12T21'),
    revision: 4
  });
  context.store.seed({ pk: 'MCPMETA#u1', sk: 'USE#f', at: 1 });
  context.store.seed({
    pk: 'USER#u1',
    sk: `ACTIVITY#${at('11T10')}#mail#m1`,
    kind: 'mail',
    at: at('11T10'),
    message: 'm1',
    received_at: at('11T10'),
    via: 'address',
    outcome: 'filed'
  });
  assert.equal(await run(context, 'u1', 'build-a'), 'ready');
  const row = await context.store.export('u1'),
    zip = await unzip((await context.objects.get(String(row?.export_key))).body),
    prefix = 'release-notes-2026-10-13/',
    data = JSON.parse(zip.get(prefix + 'release-notes.json')!.toString()) as ExportData,
    md = zip.get(prefix + 'release-notes.md')!.toString();
  assert.deepEqual(
    data.activity?.map((e) => e.id),
    [`${at('11T10')}#mail#m1`, `${at('12T05')}#reads#f`, `${at('12T15')}#mail#m2`]
  );
  assert.deepEqual(data.activity?.[1], {
    id: `${at('12T05')}#reads#f`,
    at: at('12T05'),
    kind: 'reads',
    day: '2026-10-12',
    client: 'Claude',
    connection: 'f',
    calls: 4,
    tools: { notes_list: 4 },
    last_at: at('12T21')
  });
  assert.deepEqual(
    [data.activity?.[2]?.text, data.activity?.[2]?.notified, data.activity?.[0]?.kind],
    ['Late words', true, 'mail']
  );
  for (const hidden of ['MCPMETA#', 'USE#', 'expires_at', 'revision'])
    assert.ok(!JSON.stringify(data.activity).includes(hidden), hidden);
  assert.ok(!md.includes('Late words'));
  // The words alone come straight from the API with the same log.
  const words = build(await context.store.exportItems('u1'), '2026-10-13T07:00:00Z');
  assert.deepEqual(words.activity, data.activity);
  assert.equal(
    build([{ sk: 'PROFILE', birthday: '1981-06-14', tz: 'America/Chicago' }], '2026-10-13T07:00:00Z').activity,
    undefined
  );
});
test('a token’s note carries “via <name>” in both exports, never an “Added by” line or into the email', () => {
  const items = [
      { sk: 'PROFILE', birthday: '1981-06-14', tz: 'America/Chicago' },
      {
        sk: 'NOTE#2026-10-12#t-1',
        version: '4.5.120',
        text: 'Coffee on the porch #walks',
        source: 'api',
        connection: 'tok1',
        token: 'Changelog on my iPhone',
        client: 'Changelog',
        received_at: '2026-10-12T14:00:00Z'
      },
      {
        sk: 'NOTE#2026-10-12#w-2',
        version: '4.5.120',
        text: 'Lake day',
        source: 'web',
        token: 'not a token note',
        received_at: '2026-10-12T15:00:00Z'
      }
    ],
    data = build(items, '2026-10-13T07:00:00Z'),
    md = markdown(data),
    byId = (id: string) => data.notes.find((n) => n.id === id)!;
  assert.equal(byId('t-1').token, 'Changelog on my iPhone');
  assert.equal(byId('t-1').author, 'user');
  assert.ok(!('token' in byId('w-2')));
  assert.match(md, /Coffee on the porch #walks\n\(via Changelog on my iPhone\)/);
  assert.ok(!md.includes('Added by'));
  assert.ok(!md.includes('not a token note'));
  // The morning email combines without it (workers/send.ts).
  assert.equal(combine(items.slice(1)), 'Coffee on the porch #walks\n\nLake day');
});
test('ZIP carries Upcoming separately in both exports without adding journal notes', async () => {
  const context = await setup();
  const entry = {
    id: 'concert',
    tag: 'sps',
    kind: 'event' as const,
    title: 'A concert',
    date: '2026-10-20',
    year: null,
    end_date: null,
    place: null,
    email: true,
    reminders: [7, 1, 0],
    revision: 1,
    created_at: '2026-10-13T07:00:00Z',
    updated_at: '2026-10-13T07:00:00Z'
  };
  assert.equal(await context.store.saveUpcoming('u1', entry, null), true);
  assert.equal(await run(context, 'u1', 'build-a'), 'ready');
  const row = await context.store.export('u1'),
    zip = await unzip((await context.objects.get(String(row?.export_key))).body),
    prefix = 'release-notes-2026-10-13/';
  const data = JSON.parse(zip.get(prefix + 'release-notes.json')!.toString());
  assert.deepEqual(data.upcoming, [entry]);
  assert.equal(data.notes.length, 1);
  assert.match(zip.get(prefix + 'release-notes.md')!.toString(), /## Upcoming/);
  assert.ok(
    zip
      .get(prefix + 'release-notes.md')!
      .toString()
      .includes('Tag: \\#sps.')
  );
});
test('replaced or deleting builds cannot publish an export', async () => {
  const context = await setup();
  await context.store.updateProfile('u1', { mcp_deleting: true });
  assert.equal(await run(context, 'u1', 'build-a'), 'skipped');
  assert.equal(context.objects.calls.filter((c) => c.operation === 'uploadFile').length, 0);
  await context.store.updateProfile('u1', {}, ['mcp_deleting']);
  const upload = context.objects.uploadFile.bind(context.objects);
  context.objects.uploadFile = async (...args) => {
    await upload(...args);
    await context.store.startExport('u1', 'build-b', context.now + 1000, context.now + 1960);
  };
  assert.equal(await run(context, 'u1', 'build-a'), 'replaced');
  await assert.rejects(context.objects.get('exports/u1/build-a.zip'));
  assert.equal((await context.store.export('u1'))?.id, 'build-b');
});
test('a failed export becomes failed and reports no private content', async () => {
  const context = await setup(),
    logs: Item[] = [];
  context.log = (fields) => {
    logs.push(fields);
  };
  context.objects.get = async () => {
    throw new Error('Private text must not be logged');
  };
  await assert.rejects(run(context, 'u1', 'build-a'));
  assert.equal((await context.store.export('u1'))?.status, 'failed');
  assert.deepEqual(logs, [{ event: 'export-failed', user: 'u1' }]);
});

test('atomic completion refuses a deletion that starts after the final profile read', async () => {
  const context = await setup();
  const finish = context.store.finishExportGuarded.bind(context.store);
  context.store.finishExportGuarded = async (...args) => {
    await context.store.updateProfile('u1', { mcp_deleting: true });
    return finish(...args);
  };
  assert.equal(await run(context, 'u1', 'build-a'), 'replaced');
  await assert.rejects(context.objects.get('exports/u1/build-a.zip'));
  assert.equal((await context.store.export('u1'))?.status, 'building');
});
