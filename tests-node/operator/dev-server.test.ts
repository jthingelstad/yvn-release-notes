import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { devOptions, loadDayOne } from '../../tools/dev-server.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import { createApp } from '../../server/app/app.ts';
import * as auth from '../../packages/backend/auth.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
import type { Item } from '../../packages/backend/store.ts';
const now = Date.parse('2026-10-13T12:00:00Z') / 1000,
  origin = 'http://localhost:8790';
const profile = {
  pk: 'USER#u1',
  sk: 'PROFILE',
  email: 'ada@example.com',
  birthday: '1981-06-14',
  tz: 'America/Chicago',
  city: 'Minneapolis',
  lat: 44.98,
  lon: -93.26
};
async function zip(path: string, files: Record<string, Buffer>) {
  const archive = new ZipFile();
  for (const [name, bytes] of Object.entries(files)) archive.addBuffer(bytes, name);
  archive.end();
  const chunks: Buffer[] = [];
  for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk));
  await writeFile(path, Buffer.concat(chunks));
}
const entry = (id: string, text: string, extras: Item = {}) => ({
  uuid: id.repeat(32),
  creationDate: '2016-07-05T01:40:00Z',
  timeZone: 'America/New_York',
  text,
  ...extras
});
test('dev server arguments preserve repeated Day One options without importing a running server', () => {
  assert.deepEqual(
    devOptions([
      '--dayone',
      'fiction-one.zip',
      '--port',
      '8123',
      '--dayone',
      'fiction-two.zip',
      '--fake-links',
      '--fake-places'
    ]),
    { port: 8123, dayone: ['fiction-one.zip', 'fiction-two.zip'], help: undefined }
  );
  assert.deepEqual(devOptions([]).dayone, []);
  assert.throws(() => devOptions(['--port', '70000']));
  assert.throws(() => devOptions(['--dayone']));
  assert.throws(() => devOptions(['--write']));
});
test('multiple fictional ZIPs preview through real importer and API with local media; repeat stays idempotent', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'yvn-dev-preview-'));
  try {
    const a = join(folder, 'one.zip'),
      b = join(folder, 'two.zip'),
      bytes = Buffer.from('%PDF-1.4 fictional menu');
    await zip(a, {
      'Journal.json': Buffer.from(
        JSON.stringify({
          entries: [
            entry('A', 'Walked along [the pier](https://pier.example/). #travel', {
              pdfAttachments: [{ md5: 'f1', pdfName: 'Menu' }]
            })
          ]
        })
      ),
      'pdfs/f1.pdf': bytes
    });
    await zip(b, { 'Gratitude.json': Buffer.from(JSON.stringify({ entries: [entry('B', 'A quiet evening.')] })) });
    const store = new FakeStore([profile]),
      objects = new FakeObjects(),
      mail = new FakeMail(),
      invocations = new FakeInvocations(),
      calls: string[] = [];
    objects.download = async (key) => '/dev-media/' + key;
    const context: ApiContext = {
      store,
      objects,
      mail,
      invocations,
      origin,
      now,
      from: 'notes@example.com',
      inboundDomain: 'in.example.com',
      senderFunction: 'dev-sender',
      exportFunction: 'dev-export',
      fetchTitle: () => {
        throw new Error('Named link must not fetch');
      },
      weatherFetch: async (url) => {
        calls.push(url);
        const day = new URL(url).searchParams.get('start_date');
        return { daily: { time: [day], temperature_2m_max: [17.5], temperature_2m_min: [8], weather_code: [2] } };
      }
    };
    const counts = await loadDayOne([a, b], { ...context, store, objects });
    assert.equal(counts.notes, 2);
    assert.equal(counts.files, 1);
    assert.equal(counts.originals, 2);
    assert.equal(counts.weather_kept, 1);
    assert.equal(calls.length, 1);
    assert.equal(mail.messages.length, 0);
    assert.equal(invocations.calls.length, 0);
    const token = auth.newToken();
    await store.putSession(auth.digest(token), { user_id: 'u1', now, expires: now + auth.SESSION_IDLE });
    const app = createApp({ context: () => ({ ...context }), viewer: () => '127.0.0.1' }),
      result = await app.request('/api/days/2016-07-04', { headers: { cookie: `${auth.COOKIE}=${token}` } });
    assert.equal(result.status, 200);
    const rendered = JSON.stringify(await result.json());
    assert.ok(rendered.includes('Walked along'));
    assert.ok(rendered.includes('A quiet evening.'));
    assert.ok(rendered.includes('/dev-media/'));
    const saved = (await store.allNotes('u1')).find((n) => String(n.sk).endsWith('d1-' + 'A'.repeat(32)))!,
      file = (saved.media as Item[])[0]!;
    assert.equal((await objects.get(String(file.key))).body.equals(bytes), true);
    objects.calls.length = 0;
    assert.equal((await loadDayOne([a, b], { ...context, store, objects })).already_imported, 2);
    assert.equal(objects.calls.length, 0);
    await store.deleteNote('u1', '2016-07-04', 'd1-' + 'B'.repeat(32));
    assert.equal((await loadDayOne([b], { ...context, store, objects })).already_imported, 1);
    assert.equal(await store.note('u1', '2016-07-04', 'd1-' + 'B'.repeat(32)), null);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('every export is planned before fake writes; preview requires fictional account and injected services', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'yvn-dev-preview-'));
  try {
    const good = join(folder, 'good.zip'),
      bad = join(folder, 'bad.zip');
    await zip(good, { 'Journal.json': Buffer.from(JSON.stringify({ entries: [entry('C', 'Fictional preview')] })) });
    await writeFile(bad, 'invalid');
    const store = new FakeStore([profile]),
      objects = new FakeObjects();
    await assert.rejects(() => loadDayOne([good, bad], { store, objects, origin, now }));
    assert.equal((await store.allNotes('u1')).length, 0);
    assert.deepEqual(objects.calls, []);
    store.seed({ ...profile, email: 'other@example.com' });
    await assert.rejects(() => loadDayOne([good], { store, objects, origin, now }), /fictional Ada/);
    await assert.rejects(
      () => loadDayOne([good], { store, objects: {} as FakeObjects, origin, now }),
      /in-memory services/
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
