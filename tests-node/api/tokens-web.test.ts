/** API tokens in Settings are every subscriber's own (docs/API.md, Tokens):
 * any signed-in account makes, lists and revokes its tokens, whoever the
 * administrator is, and never reaches another's. Fictional accounts only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app/app.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import * as auth from '../../packages/backend/auth.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
const now = Date.parse('2026-10-29T12:00:00Z') / 1000,
  origin = 'https://notes.example.com';

async function fixture(adminUserId?: string) {
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
    log: () => {}
  };
  const app = createApp({ context: () => ctx });
  async function call(method: string, path: string, value?: unknown, who: string | null = 'b') {
    const response = await app.request(path, {
      method,
      headers: { origin, ...(who ? { cookie: auth.COOKIE + '=' + who.repeat(43) } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
  }
  return { call };
}

for (const adminUserId of ['u', undefined])
  test(`a subscriber who isn't the administrator keeps their own tokens (admin ${adminUserId ?? 'unset'})`, async () => {
    const { call } = await fixture(adminUserId);
    const made = await call('POST', '/api/tokens', { name: 'Terminal', scopes: ['notes:write'], expiry: '1y' });
    assert.equal(made.status, 201);
    assert.equal(typeof made.data.token, 'string');
    const listed = await call('GET', '/api/tokens');
    assert.equal(listed.status, 200);
    assert.deepEqual(
      (listed.data.tokens as { name: string }[]).map((t) => t.name),
      ['Terminal']
    );
    // Another account sees none of them and can't end one.
    assert.deepEqual((await call('GET', '/api/tokens', undefined, 'u')).data.tokens, []);
    assert.equal((await call('DELETE', `/api/tokens/${made.data.id}`, undefined, 'u')).status, 404);
    assert.equal((await call('DELETE', `/api/tokens/${made.data.id}`)).status, 200);
    assert.deepEqual((await call('GET', '/api/tokens')).data.tokens, []);
  });

test('signed out, the token routes answer 401 and make nothing', async () => {
  const { call } = await fixture('u');
  for (const [method, value] of [
    ['GET', undefined],
    ['POST', { name: 'Terminal', scopes: ['notes:write'], expiry: '1y' }]
  ] as const)
    assert.equal((await call(method, '/api/tokens', value, null)).status, 401, method);
  assert.deepEqual((await call('GET', '/api/tokens')).data.tokens, []);
});
