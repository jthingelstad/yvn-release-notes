/** Fictional administrator, subscriber and session; no live data or services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app/app.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import * as auth from '../../packages/backend/auth.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
import type { ProductUpdate } from '../../packages/domain/product-updates.ts';
const now = Date.parse('2026-10-13T12:00:00Z') / 1000,
  origin = 'https://notes.example.com';
async function fixture(adminUserId: string | undefined = 'u') {
  const store = new FakeStore(
    ['u', 'b'].map((uid) => ({
      pk: 'USER#' + uid,
      sk: 'PROFILE',
      email: uid === 'u' ? 'ada@example.com' : 'bea@example.com',
      birthday: '1981-06-14',
      tz: 'America/Chicago',
      status: 'active'
    })),
    'T',
    1
  );
  for (const uid of ['u', 'b'])
    await store.putSession(auth.digest(uid.repeat(43)), { user_id: uid, now, expires: now + 86400 });
  const logs: unknown[] = [];
  const ctx: ApiContext = {
    store,
    now,
    origin,
    objects: new FakeObjects(),
    mail: new FakeMail(),
    invocations: new FakeInvocations(),
    from: 'notes@example.com',
    inboundDomain: 'in.example.com',
    senderFunction: 'sender',
    exportFunction: 'export',
    adminUserId,
    fetchTitle: () => ({ title: 'Connect an agent', site: 'example.com' }),
    log: (f) => logs.push(f)
  };
  const app = createApp({ context: () => ctx });
  async function call(method: string, path = '/api/admin/updates', value?: unknown, token = 'u', from = origin) {
    const response = await app.request(path, {
      method,
      headers: { origin: from, cookie: auth.COOKIE + '=' + token.repeat(43) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, data: await response.json() };
  }
  async function draft(title = 'Agent connections') {
    const response = await call('POST', undefined, {
      title,
      text: 'Connect at https://example.com/connect.\nA fictional update.'
    });
    assert.equal(response.status, 201);
    return response.data as ProductUpdate;
  }
  return { store, ctx, call, draft, logs };
}
test('admin disabled by default; signed-out, ordinary and forged-origin writes cannot access product updates', async () => {
  const f = await fixture('');
  assert.equal((await f.call('GET')).status, 403);
  f.ctx.adminUserId = 'u';
  assert.equal((await f.call('GET', undefined, undefined, '')).status, 401);
  for (const [method, path, value] of [
    ['GET', '/api/admin/updates', undefined],
    ['POST', '/api/admin/updates', { title: 'Private', text: 'Words' }],
    ['PUT', '/api/admin/updates/id', { revision: 1 }],
    ['DELETE', '/api/admin/updates/id', { revision: 1 }],
    ['POST', '/api/admin/updates/id/schedule', { revision: 1, date: '2026-10-14' }],
    ['DELETE', '/api/admin/updates/id/schedule', { revision: 1 }]
  ] as const)
    assert.equal((await f.call(method, path, value, 'b')).status, 403);
  assert.equal(
    (await f.call('POST', undefined, { title: 'Private', text: 'Words' }, 'u', 'https://elsewhere.example')).status,
    403
  );
  assert.equal((await f.call('GET', '/api/me')).data.admin, true);
  assert.equal((await f.call('GET', '/api/me', undefined, 'b')).data.admin, undefined);
  assert.equal((await f.call('PUT', '/api/me', { send_time: '07:00' })).data.admin, true);
  assert.equal((await f.store.productUpdates()).length, 0);
});
test('saved drafts, revisions, immutable scheduling, occupied dates, cancellation and deletion', async () => {
  const f = await fixture(),
    a = await f.draft(),
    b = await f.draft('Another change');
  assert.equal((await f.store.productUpdates()).length, 2); // one-row pages still collect all drafts
  assert.equal(await f.store.scheduledProductUpdate('2026-10-14'), null);
  assert.equal(
    (await f.call('PUT', '/api/admin/updates/' + a.id, { revision: 0, title: 'Edited', text: 'Words' })).status,
    409
  );
  const scheduled = await f.call('POST', '/api/admin/updates/' + a.id + '/schedule', {
    revision: 1,
    date: '2026-10-14'
  });
  assert.equal(scheduled.status, 200);
  assert.equal((await f.store.scheduledProductUpdate('2026-10-14'))?.text, a.text);
  assert.equal(
    (await f.call('POST', '/api/admin/updates/' + b.id + '/schedule', { revision: 1, date: '2026-10-14' })).status,
    409
  );
  assert.equal((await f.store.productUpdate(b.id))?.status, 'draft');
  assert.equal(
    (await f.call('PUT', '/api/admin/updates/' + a.id, { revision: 2, title: 'Edited', text: 'Words' })).status,
    409
  );
  assert.equal((await f.call('DELETE', '/api/admin/updates/' + a.id, { revision: 2 })).status, 409);
  const cancelled = await f.call('DELETE', '/api/admin/updates/' + a.id + '/schedule', { revision: 2 });
  assert.equal(cancelled.status, 200);
  assert.equal(await f.store.scheduledProductUpdate('2026-10-14'), null);
  assert.equal(
    (await f.call('PUT', '/api/admin/updates/' + a.id, { revision: 3, title: 'Edited', text: 'New words' })).status,
    200
  );
  assert.equal((await f.call('DELETE', '/api/admin/updates/' + a.id, { revision: 4 })).status, 200);
  assert.equal(await f.store.productUpdate(a.id), null);
  assert.ok(!JSON.stringify(f.logs).includes('@'));
  assert.ok(!JSON.stringify(f.logs).includes('fictional update'));
});
test('invalid dates/content and code-point limits; titles fetched once and kept through scheduling', async () => {
  const f = await fixture();
  let fetched = 0;
  f.ctx.fetchTitle = () => {
    fetched++;
    return { title: 'Safe named link', site: 'example.com' };
  };
  for (const value of [
    { title: '', text: 'text' },
    { title: 'line\nbreak', text: 'text' },
    { title: 'a'.repeat(121), text: 'text' },
    { title: 'ok', text: '😀'.repeat(2001) },
    { title: 'ok', text: 4 }
  ])
    assert.equal((await f.call('POST', undefined, value)).status, 400);
  assert.equal((await f.call('POST', undefined, { title: 'Emoji', text: '😀'.repeat(2000) })).status, 201);
  const a = await f.draft();
  assert.equal(fetched, 1);
  for (const date of ['2026-02-30', '2026-10-12', 'nonsense'])
    assert.equal((await f.call('POST', '/api/admin/updates/' + a.id + '/schedule', { revision: 1, date })).status, 400);
  const r = await f.call('POST', '/api/admin/updates/' + a.id + '/schedule', { revision: 1, date: '2026-10-14' });
  assert.equal(r.status, 200);
  assert.equal(fetched, 1);
  assert.equal(r.data.links[0].title, 'Safe named link');
});
test('session revoked during link fetch cannot commit a draft', async () => {
  const f = await fixture();
  f.ctx.fetchTitle = async () => {
    await f.store.deleteSession(auth.digest('u'.repeat(43)));
    return null;
  };
  const r = await f.call('POST', undefined, { title: 'A change', text: 'https://example.com/' });
  assert.equal(r.status, 409);
  assert.equal((await f.store.productUpdates()).length, 0);
});
test('simultaneous scheduling of a date commits exactly one complete snapshot', async () => {
  const f = await fixture(),
    a = await f.draft(),
    b = await f.draft('Second change');
  const results = await Promise.all(
    [a, b].map((u) => f.call('POST', '/api/admin/updates/' + u.id + '/schedule', { revision: 1, date: '2026-10-14' }))
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await f.store.productUpdates()).filter((u) => u.status === 'scheduled').length, 1);
});
