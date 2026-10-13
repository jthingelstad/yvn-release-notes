import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import * as d from '../../packages/backend/dayone.ts';
import { summary } from '../../tools/import-dayone.ts';
import type { Item } from '../../packages/backend/store.ts';
const golden = JSON.parse(await readFile(new URL('./legacy-dayone.json', import.meta.url), 'utf8')) as {
  profile: Item;
  plain: Array<{ input: string; expected: unknown }>;
  plans: Array<{
    name: string;
    entries: Item[];
    names: Record<string, number>;
    journal: string;
    expected: unknown;
    summary: unknown;
  }>;
};
for (const [i, row] of golden.plain.entries())
  test(`DayOne plain exact Python fictional parity ${i}`, () => {
    assert.deepEqual(
      d.plain(row.input, (uuid) => (uuid === 'A'.repeat(32) ? 'https://notes.example/day/?d=2016-07-04' : null)),
      row.expected
    );
  });
for (const row of golden.plans)
  test(`DayOne full plan exact Python fictional parity ${row.name}`, () => {
    const plan = d.plan(row.journal, row.entries, row.names, golden.profile, 'u1', 'https://notes.example');
    assert.deepEqual(plan, row.expected);
    assert.deepEqual(summary(plan), row.summary);
  });
async function zipFile(files: Record<string, Buffer>) {
  const zip = new ZipFile();
  for (const [name, body] of Object.entries(files)) zip.addBuffer(body, name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
export async function temporaryArchive(files: Record<string, Buffer>) {
  const dir = await mkdtemp(join(tmpdir(), 'yvn-dayone-test-')),
    path = join(dir, 'made-up.zip');
  await writeFile(path, await zipFile(files));
  return { dir, path, remove: () => rm(dir, { recursive: true, force: true }) };
}
test('bounded ZIP reader returns journal and canonical member sizes/content without extraction', async () => {
  const t = await temporaryArchive({
    'Journal.json': Buffer.from(JSON.stringify({ entries: golden.plans[0]!.entries })),
    'photos/p1.jpeg': Buffer.from('synthetic photo'),
    'ignored.txt': Buffer.from('ignored')
  });
  try {
    const archive = await d.read(t.path);
    try {
      assert.equal(archive.journal, 'Journal');
      assert.deepEqual(archive.entries, golden.plans[0]!.entries);
      assert.equal(archive.names['photos/p1.jpeg'], 15);
      assert.equal((await archive.read('photos/p1.jpeg')).toString(), 'synthetic photo');
      await assert.rejects(() => archive.read('ignored.txt'), { name: 'ExportError' });
      await assert.rejects(() => archive.read('photos/p1.jpeg', 10), { message: 'Export member exceeds read limit' });
    } finally {
      archive.close();
    }
  } finally {
    await t.remove();
  }
});
test('ZIP refuses oversized journal before inflation, too many members, missing/malformed top journal', async () => {
  for (const [files, limits, message] of [
    [{ 'Journal.json': Buffer.from('{"entries":[]}') }, { maxJson: 2 }, 'Export member exceeds read limit'],
    [
      { 'Journal.json': Buffer.from('{"entries":[]}'), 'photos/x.jpeg': Buffer.from('x') },
      { maxMembers: 1 },
      'Too many zip members'
    ],
    [
      { 'nested/Journal.json': Buffer.from('{"entries":[]}') },
      {},
      'no journal JSON at the top of the zip: not a Day One export'
    ],
    [{ 'Journal.json': Buffer.from('{"entries":"wrong"}') }, {}, 'Invalid journal entries'],
    [{ 'Journal.json': Buffer.from('private malformed words') }, {}, 'Invalid journal JSON']
  ] as Array<[Record<string, Buffer>, Parameters<typeof d.read>[1], string]>) {
    const t = await temporaryArchive(files);
    try {
      await assert.rejects(() => d.read(t.path, limits), { name: 'ExportError', message });
    } finally {
      await t.remove();
    }
  }
});
test('ZIP detects corrupted member CRC and refuses canonical path escape', async () => {
  const t = await temporaryArchive({
    'Journal.json': Buffer.from('{"entries":[]}'),
    'photos/p1.jpeg': Buffer.from('synthetic')
  });
  try {
    let bytes = await readFile(t.path);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(central >= 0);
    bytes = Buffer.from(bytes);
    bytes.writeUInt32LE(0, central + 16);
    await writeFile(t.path, bytes);
    await assert.rejects(() => d.read(t.path), { message: 'Export member integrity mismatch' });
  } finally {
    await t.remove();
  }
  assert.deepEqual(
    [...d.byMd5(['photos/p1.jpeg', 'photos/../p2.jpeg', 'photos/sub/p3.jpeg', 'videos/v1.mov', 'pdfs/f 1.pdf'])],
    [['photos/p1', 'photos/p1.jpeg']]
  );
});
test('ZIP refuses symlink, encrypted, unsupported and duplicate central directory members', async () => {
  for (const kind of ['symlink', 'encrypted', 'unsupported', 'duplicate']) {
    const t = await temporaryArchive({
      'Journal.json': Buffer.from('{"entries":[]}'),
      'Other00.json': Buffer.from('{"entries":[]}')
    });
    try {
      const bytes = Buffer.from(await readFile(t.path)),
        signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]),
        first = bytes.indexOf(signature),
        second = bytes.indexOf(signature, first + 4);
      assert.ok(first >= 0 && second > first);
      if (kind === 'symlink') bytes.writeUInt32LE(0xa1ff0000, first + 38);
      if (kind === 'encrypted') bytes.writeUInt16LE(bytes.readUInt16LE(first + 8) | 1, first + 8);
      if (kind === 'unsupported') bytes.writeUInt16LE(99, first + 10);
      if (kind === 'duplicate') Buffer.from('Journal.json').copy(bytes, second + 46);
      await writeFile(t.path, bytes);
      await assert.rejects(() => d.read(t.path), { name: 'ExportError' });
    } finally {
      await t.remove();
    }
  }
});
