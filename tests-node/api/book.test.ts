/** /api/book: anyone may make a book, what a span holds, and the build's
 * row, invocation and file. Fictional subscribers and sessions; no live data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app/app.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import * as auth from '../../packages/backend/auth.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import { bookKey } from '../../workers/export.ts';

const now = Date.parse('2026-10-13T17:00:00Z') / 1000,
  origin = 'https://notes.example.com';

async function fixture(standing: Record<string, string | undefined> = { u: 'member' }) {
  const store = new FakeStore(
      ['u', 'b'].map((uid) => ({
        pk: 'USER#' + uid,
        sk: 'PROFILE',
        email: `${uid}@example.com`,
        birthday: '1981-06-14',
        tz: 'America/Chicago',
        status: 'active',
        ...(standing[uid] ? { weekly_thing: standing[uid] } : {})
      })),
      'T',
      1
    ),
    objects = new FakeObjects(),
    invocations = new FakeInvocations();
  for (const uid of ['u', 'b'])
    await store.putSession(auth.digest(uid.repeat(43)), { user_id: uid, now, expires: now + 86400 });
  for (const uid of ['u', 'b'])
    await store.putNote(uid, '2026-10-12', 'w-a', {
      text: 'Lake day.',
      source: 'web',
      written_at: '2026-10-12T20:00:00Z',
      media: [
        { n: 1, kind: 'image', type: 'image/jpeg', key: `media/${uid}/files/a.jpg`, size: 5 },
        { n: 2, kind: 'image', type: 'image/jpeg', key: 'media/someone/files/b.jpg', size: 5 },
        { n: 3, kind: 'audio', type: 'audio/mp4', key: `media/${uid}/files/c.m4a`, size: 5 }
      ]
    });
  const ctx: ApiContext = {
    store,
    now,
    origin,
    objects,
    mail: new FakeMail(),
    invocations,
    from: 'notes@example.com',
    inboundDomain: 'in.example.com',
    senderFunction: 'sender',
    exportFunction: 'export',
    adminUserId: undefined,
    fetchTitle: () => null,
    log: () => undefined
  };
  const app = createApp({ context: () => ctx });
  async function call(method: string, path: string, value?: unknown, token = 'u') {
    const response = await app.request(path, {
      method,
      redirect: 'manual',
      headers: { origin, cookie: auth.COOKIE + '=' + token.repeat(43) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, data: (text ? JSON.parse(text) : {}) as Item };
  }
  return { store, objects, invocations, ctx, call };
}

test('anyone may make a book, member or not, and see what a span holds', async () => {
  const { call, invocations } = await fixture();
  // b has no Weekly Thing standing on record at all.
  assert.deepEqual((await call('GET', '/api/book', undefined, 'b')).data, {
    today: '2026-10-13',
    status: 'none'
  });
  assert.deepEqual((await call('GET', '/api/book/plan?from=2026-10-12&to=2026-10-13', undefined, 'b')).data, {
    from: '2026-10-12',
    to: '2026-10-13',
    title: 'October 12, 2026 to October 13, 2026',
    days: 1,
    notes: 1,
    // Only the owner's own files count.
    photos: 1,
    memos: 1,
    max_photos: 1000
  });
  assert.equal((await call('POST', '/api/book', { from: '2026-10-12', to: '2026-10-12' }, 'b')).status, 202);
  assert.equal(invocations.calls.length, 1);
});

test('a book’s days and title are checked before anything is written', async () => {
  const { store, call, invocations } = await fixture();
  for (const [body, error] of [
    [{ from: '2026-10-13', to: '2026-10-12' }, 'date'],
    [{ from: '1981-06-13', to: '2026-10-12' }, 'date'],
    [{ from: '2026-10-12', to: '2026-10-14' }, 'date'],
    [{ from: '2026-10-12' }, 'date'],
    [{ from: '2026-10-12', to: '2026-10-12', title: 'x'.repeat(81) }, 'title'],
    [{ from: '2026-10-12', to: '2026-10-12', title: 'Two\u0007lines' }, 'title'],
    [{ from: '2026-10-12', to: '2026-10-12', title: 7 }, 'title'],
    [{ from: '2026-10-12', to: '2026-10-12', page: 'a4' }, 'book-page'],
    [{ from: '2026-10-12', to: '2026-10-12', page: 6 }, 'book-page'],
    [{ from: '2026-10-01', to: '2026-10-11' }, 'book-empty']
  ] as const) {
    const r = await call('POST', '/api/book', body);
    assert.deepEqual([r.status, r.data.error], [400, error], JSON.stringify(body));
  }
  assert.ok(!(await store.export('u', 'BOOK')));
  assert.equal(invocations.calls.length, 0);
  // At the limit a book is fine; one more photo is too many.
  const photos = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      n: i + 1,
      kind: 'image',
      type: 'image/jpeg',
      key: `media/u/files/${i}.jpg`,
      size: 5
    }));
  await store.putNote('u', '2026-10-11', 'w-b', { text: 'Many', source: 'web', media: photos(999) });
  assert.equal((await call('GET', '/api/book/plan?from=2026-10-11&to=2026-10-12')).data.photos, 1000);
  await store.putNote('u', '2026-10-10', 'w-c', { text: 'More', source: 'web', media: photos(1) });
  const over = await call('POST', '/api/book', { from: '2026-10-10', to: '2026-10-12' });
  assert.deepEqual(
    [over.status, over.data.error, over.data.photos, over.data.max_photos],
    [400, 'book-photos', 1001, 1000]
  );
});

test('a book starts its own row, invokes the export worker and is recorded by its days', async () => {
  const { store, call, invocations } = await fixture();
  const started = await call('POST', '/api/book', { from: '2026-10-12', to: '2026-10-13', title: '  Lake   week ' });
  assert.deepEqual([started.status, started.data], [202, { status: 'building' }]);
  const row = (await store.export('u', 'BOOK'))!;
  assert.deepEqual(
    [row.status, row.from, row.to, row.page, row.title, row.started_at, row.expires_at],
    ['building', '2026-10-12', '2026-10-13', '6x9', 'Lake week', now, now + 86400]
  );
  assert.ok(!(await store.export('u')));
  assert.deepEqual(invocations.calls, [
    { name: 'export', payload: { user_id: 'u', id: row.id, kind: 'book' }, asynchronous: true }
  ]);
  const activity = store.memory.all().filter((i) => i.pk === 'USER#u' && String(i.sk).startsWith('ACTIVITY#'));
  assert.deepEqual(
    activity.map((a) => [a.kind, a.from, a.to]),
    [['export.book', '2026-10-12', '2026-10-13']]
  );
  // One at a time: a second ask while it builds starts nothing.
  assert.deepEqual((await call('POST', '/api/book', { from: '2026-10-12', to: '2026-10-12' })).status, 202);
  assert.equal(invocations.calls.length, 1);
  assert.deepEqual((await call('GET', '/api/book')).data, {
    today: '2026-10-13',
    status: 'building',
    from: '2026-10-12',
    to: '2026-10-13',
    page: '6x9',
    title: 'Lake week'
  });
});

test('a ready book is linked as a PDF download and replaced by the next one', async () => {
  const { store, objects, call } = await fixture();
  assert.equal((await call('GET', '/api/book/file')).status, 404);
  await call('POST', '/api/book', { from: '2026-10-12', to: '2026-10-12', page: 'letter' });
  const id = String((await store.export('u', 'BOOK'))!.id),
    key = bookKey('u', id);
  await objects.put(key, Buffer.from('%PDF-1.7 fictional'), { type: 'application/pdf' });
  await store.finishExport(
    'u',
    id,
    {
      status: 'ready',
      finished_at: now,
      export_key: key,
      size: 18,
      pages: 4,
      photos: 1,
      missing: 0,
      expires_at: now + 86400
    },
    'BOOK'
  );
  assert.deepEqual((await call('GET', '/api/book')).data, {
    today: '2026-10-13',
    status: 'ready',
    from: '2026-10-12',
    to: '2026-10-12',
    page: 'letter',
    size: 18,
    pages: 4,
    photos: 1,
    missing: 0,
    built_at: '2026-10-13T17:00:00Z',
    until: '2026-10-14T17:00:00Z'
  });
  const file = await call('GET', '/api/book/file');
  assert.equal(file.status, 302);
  const link = new URL(file.headers.get('location')!);
  assert.equal(decodeURIComponent(link.pathname.slice(1)), key);
  assert.equal(link.searchParams.get('type'), 'application/pdf');
  assert.equal(
    link.searchParams.get('disposition'),
    'attachment; filename="release-notes-2026-10-12-to-2026-10-12.pdf"'
  );
  assert.equal((await call('POST', '/api/book', { from: '2026-10-12', to: '2026-10-13' })).status, 202);
  assert.ok(objects.calls.some((c) => c.operation === 'remove' && c.key === key));
  assert.notEqual((await store.export('u', 'BOOK'))!.id, id);
});

test('a book that could not start, or ran past the worker, says it failed', async () => {
  const { store, call, invocations, ctx } = await fixture();
  invocations.fail = true;
  const failed = await call('POST', '/api/book', { from: '2026-10-12', to: '2026-10-12' });
  assert.deepEqual([failed.status, failed.data.error], [502, 'book-failed']);
  assert.equal((await store.export('u', 'BOOK'))!.status, 'failed');
  assert.equal((await call('GET', '/api/book')).data.status, 'failed');
  invocations.fail = false;
  assert.equal((await call('POST', '/api/book', { from: '2026-10-12', to: '2026-10-12' })).status, 202);
  ctx.now = now + 961;
  assert.equal((await call('GET', '/api/book')).data.status, 'failed');
  // Then it may be tried again.
  assert.equal((await call('POST', '/api/book', { from: '2026-10-12', to: '2026-10-12' })).status, 202);
  assert.equal(invocations.calls.length, 2);
  // An empty book says why.
  const id = String((await store.export('u', 'BOOK'))!.id);
  await store.finishExport('u', id, { status: 'failed', reason: 'empty', finished_at: ctx.now }, 'BOOK');
  assert.equal((await call('GET', '/api/book')).data.reason, 'empty');
});
