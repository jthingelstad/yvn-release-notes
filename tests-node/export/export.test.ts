import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fromBuffer } from 'yauzl';
import { build, markdown, filePaths, type ExportData, type FilePaths } from '../../packages/backend/export.ts';
import { run } from '../../workers/export.ts';
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
    const data = build(f.items, '2026-10-13T07:00:00Z', files);
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
test('ZIP carries Upcoming separately in both exports without adding journal notes', async () => {
  const context = await setup();
  const entry = {
    id: 'concert',
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
