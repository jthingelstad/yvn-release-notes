/** Legacy HTTP security/lifecycle boundaries grouped by behavior, using only
 * fictional local services. These complement wire goldens and transaction tests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { readFile } from 'node:fs/promises';
import { createApp } from '../../server/app/app.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import * as auth from '../../packages/backend/auth.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
import type { Item } from '../../packages/backend/store.ts';
const origin = 'https://notes.example.com',
  initial = Date.parse('2026-10-13T12:00:00Z') / 1000;
const profile = {
  pk: 'USER#u',
  sk: 'PROFILE',
  email: 'ada@example.com',
  birthday: '1981-06-14',
  tz: 'America/Chicago',
  status: 'active',
  send_time: '06:00',
  city: 'Home',
  country: 'United States',
  lat: 44,
  lon: -93
};
async function setup() {
  const store = new FakeStore([profile, { pk: 'EMAIL#ada@example.com', sk: 'EMAIL', user_id: 'u' }]),
    objects = new FakeObjects(),
    mail = new FakeMail(),
    invocations = new FakeInvocations(),
    logs: Item[] = [];
  let now = initial,
    viewer = '198.51.100.1';
  const context = (): ApiContext => ({
    store,
    objects,
    mail,
    invocations,
    origin,
    now,
    from: 'notes@example.com',
    inboundDomain: 'in.example.com',
    senderFunction: 'sender',
    exportFunction: 'export',
    weatherFetch: async () => ({}),
    fetchTitle: () => null,
    log: (f) => logs.push(f)
  });
  const app = createApp({ context, viewer: () => viewer });
  async function call(method: string, path: string, value?: unknown, token = '') {
    const response = await app.request(path, {
      method,
      headers: { origin, ...(token ? { cookie: `${auth.COOKIE}=${token}` } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    return { response, data: (await response.json()) as Item };
  }
  async function login(email = 'ada@example.com', code = '123456') {
    const token = auth.newToken();
    await store.putLogin(auth.digest(token), email, auth.digest(email), auth.digest(code), now, auth.LOGIN_TTL);
    return { token, code };
  }
  async function session() {
    const token = auth.newToken();
    await store.createSession(auth.digest(token), { user_id: 'u', now, expires: auth.sessionExpiry(now) });
    return token;
  }
  return {
    store,
    objects,
    mail,
    invocations,
    logs,
    context,
    call,
    login,
    session,
    setNow: (n: number) => {
      now = n;
    },
    setViewer: (v: string) => {
      viewer = v;
    }
  };
}
test('pause changes preserve elapsed history, replace future spans and use the subscriber local sent day', async () => {
  const s = await setup(),
    cookie = await s.session();
  s.store.seed({ ...profile, last_sent_date: '2026-10-13' });
  assert.equal((await s.call('PUT', '/api/pause', { days: 3 }, cookie)).response.status, 200);
  assert.equal((await s.store.profile('u'))!.pause_from, '2026-10-14');
  assert.equal((await s.call('PUT', '/api/pause', { days: 1 }, cookie)).response.status, 200);
  assert.equal((await s.store.profile('u'))!.pause_through, '2026-10-14');
  await s.call('DELETE', '/api/pause', undefined, cookie);
  assert.deepEqual(await s.store.pauses('u'), []);
  s.store.seed(profile);
  await s.call('PUT', '/api/pause', { days: 3 }, cookie);
  s.setNow(initial + 86400);
  await s.call('PUT', '/api/pause', { days: 4 }, cookie);
  assert.equal((await s.store.profile('u'))!.pause_from, '2026-10-13');
  await s.call('DELETE', '/api/pause', undefined, cookie);
  assert.deepEqual(await s.store.pauses('u'), [['2026-10-13', '2026-10-13']]);
  s.store.seed({ ...profile, status: 'stopped' });
  assert.equal((await s.call('PUT', '/api/pause', { days: 3 }, cookie)).data.error, 'stopped');
});
test('restart unsuppresses bounce/complaint only; SES failure retains stopped state and signup survives first-email failure', async () => {
  for (const reason of ['bounce', 'complaint', 'unsubscribed']) {
    const s = await setup(),
      cookie = await s.session();
    s.store.seed({ ...profile, status: 'stopped', stopped_reason: reason });
    s.mail.suppressed.add('ada@example.com');
    assert.equal((await s.call('PUT', '/api/me', { status: 'active' }, cookie)).response.status, 200);
    assert.equal(s.mail.suppressed.has('ada@example.com'), reason === 'unsubscribed');
    assert.equal((await s.store.profile('u'))!.stopped_reason, undefined);
  }
  const s = await setup(),
    cookie = await s.session();
  s.store.seed({ ...profile, status: 'stopped', stopped_reason: 'bounce' });
  s.mail.unsuppress = async () => {
    throw new Error('private-provider-error');
  };
  assert.equal((await s.call('PUT', '/api/me', { status: 'active' }, cookie)).response.status, 502);
  assert.equal((await s.store.profile('u'))!.status, 'stopped');
  const login = await s.login('bea@example.com');
  const verified = await s.call('POST', '/api/auth/verify', { token: login.token });
  const fresh = verified.response.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
  s.invocations.invoke = async () => {
    throw new Error('private-provider-error');
  };
  const created = await s.call(
    'PUT',
    '/api/me',
    {
      birthday: '1981-06-14',
      send_time: '23:45',
      place: { name: 'Home', country: 'United States', tz: 'America/Chicago', lat: 44, lon: -93 }
    },
    fresh
  );
  assert.equal(created.response.status, 200);
  assert.ok(await s.store.userForEmail('bea@example.com'));
  assert.ok(s.logs.some((l) => l.event === 'first-email-failed'));
  assert.ok(!JSON.stringify(s.logs).includes('private-provider-error'));
});
test('native HTTP admission rejects bad bodies, empty or out-of-calendar notes and unsafe upload forms before media moves', async () => {
  const s = await setup(),
    cookie = await s.session();
  for (const [path, value] of [
    ['/api/days/1981-06-13/notes', { text: 'before birthday' }],
    ['/api/days/2026-10-14/notes', { text: 'future' }],
    ['/api/days/2026-10-13/notes', { text: '   ' }],
    ['/api/days/2026-10-13/notes', { text: 'x'.repeat(20001) }],
    ['/api/days/2026-10-13/notes', { text: 'invalid place', place: { lat: 44 } }],
    [
      '/api/days/2026-10-13/notes',
      { uploads: Array.from({ length: 21 }, () => ({ upload: 'a'.repeat(32), type: 'application/pdf' })) }
    ],
    ['/api/uploads', { name: 'a.pdf', type: 'application/pdf', size: 0 }],
    ['/api/uploads', { name: 'a.pdf', type: 'application/pdf', size: true }],
    ['/api/uploads', { name: 'a.pdf', type: 'application/pdf', size: 50 * 1024 ** 2 + 1 }]
  ] as const)
    assert.equal((await s.call('POST', path, value, cookie)).response.status, 400);
  assert.equal((await s.call('POST', '/api/days/2026-10-13/notes', [], cookie)).response.status, 400);
  assert.deepEqual(await s.store.allNotes('u'), []);
  assert.ok(!s.objects.calls.some((c) => c.operation === 'copy'));
  s.mail.fail = true;
  assert.equal((await s.call('POST', '/api/auth/start', { email: 'bea@example.com' })).response.status, 502);
});
test('HTTP sign-in hides account existence, stores hashes, bounds code attempts and preserves newest/purpose/expiry', async () => {
  const s = await setup();
  const known = await s.call('POST', '/api/auth/start', { email: ' Ada@Example.com ' }),
    fresh = await s.call('POST', '/api/auth/start', { email: 'bea@example.com' });
  assert.deepEqual([known.response.status, known.data], [fresh.response.status, fresh.data]);
  const message = await simpleParser(s.mail.messages[0]!.raw),
    text = message.text!,
    code = /\b([0-9]{6})\b/.exec(text)![1]!,
    token = /#t=([A-Za-z0-9_-]{43})/.exec(text)![1]!;
  const stored = JSON.stringify(s.store.memory.all());
  assert.ok(!stored.includes(token));
  assert.ok(!stored.replaceAll(auth.digest(code), '').includes(code));
  await s.login('ada@example.com', '234567');
  assert.equal(
    (await s.call('POST', '/api/auth/verify', { email: 'ada@example.com', code: '123456' })).data.error,
    'wrong-code'
  );
  assert.equal(
    (await s.call('POST', '/api/auth/verify', { email: 'other@example.com', code: '234567' })).data.error,
    'code-expired'
  );
  for (let n = 1; n <= 4; n++)
    assert.equal(
      (await s.call('POST', '/api/auth/verify', { email: 'ada@example.com', code: '000000' })).data.tries_left,
      4 - n
    );
  assert.equal(
    (await s.call('POST', '/api/auth/verify', { email: 'ada@example.com', code: '234567' })).data.error,
    'too-many-tries'
  );
  const recent = await s.login('ada@example.com', '345678');
  assert.equal(
    (await s.call('POST', '/api/auth/verify', { email: 'ADA@example.com', code: '345 678' })).response.status,
    200
  );
  assert.equal((await s.call('POST', '/api/auth/verify', { token: recent.token })).data.error, 'link-used-or-expired');
  const expired = await s.login();
  s.setNow(initial + auth.LOGIN_TTL);
  assert.equal((await s.call('POST', '/api/auth/verify', { token: expired.token })).response.status, 400);
  assert.ok(!JSON.stringify(s.logs).includes('@'));
});
test('HTTP daily guess cap spans fresh logins but still permits the unguessable emailed link', async () => {
  const s = await setup();
  for (let round = 0; round < 4; round++) {
    await s.login();
    for (let n = 0; n < 5; n++)
      assert.equal(
        (await s.call('POST', '/api/auth/verify', { email: 'ada@example.com', code: '000000' })).response.status,
        400
      );
  }
  const next = await s.login();
  assert.equal(
    (await s.call('POST', '/api/auth/verify', { email: 'ada@example.com', code: next.code })).response.status,
    429
  );
  assert.equal((await s.call('POST', '/api/auth/verify', { token: next.token })).response.status, 200);
  s.setNow(initial + 86400);
  await s.login();
  assert.equal(
    (await s.call('POST', '/api/auth/verify', { email: 'ada@example.com', code: '123456' })).response.status,
    200
  );
});
test('sign-in limits compose address/IPv4/IPv6/total budgets; refusal consumes none and keeps alarm contract', async () => {
  const s = await setup(),
    hour = Math.floor(initial / 3600);
  for (let n = 0; n < 5; n++)
    assert.equal((await s.call('POST', '/api/auth/start', { email: `ada+${n}@example.com` })).response.status, 202);
  const before = s.store.memory.all();
  assert.equal((await s.call('POST', '/api/auth/start', { email: 'ada@example.com' })).response.status, 429);
  assert.deepEqual(s.store.memory.all(), before);
  for (let n = 0; n < 201; n++) await s.call('POST', '/api/auth/start', { email: `fictional${n}@example.com` });
  assert.equal(await s.store.peek('all', hour), 20);
  s.setViewer('198.51.100.2');
  assert.equal((await s.call('POST', '/api/auth/start', { email: 'bea@example.com' })).response.status, 202);
  const ipv6 = await setup();
  for (let subnet = 0; subnet < 4; subnet++) {
    ipv6.setViewer(`2001:db8:1:${subnet}::9`);
    for (let n = 0; n < 20; n++) await ipv6.call('POST', '/api/auth/start', { email: `v${subnet}-${n}@example.com` });
  }
  assert.equal(await ipv6.store.peek('all', hour), 60);
  ipv6.setViewer('2001:db8:2:1::9');
  assert.equal((await ipv6.call('POST', '/api/auth/start', { email: 'bea@example.com' })).response.status, 202);
  ipv6.store.seed({ pk: `RATE#all#${hour}`, sk: 'RATE', n: 200, expires_at: initial + 7200 });
  assert.equal((await ipv6.call('POST', '/api/auth/start', { email: 'new@example.com' })).response.status, 429);
  assert.ok(ipv6.logs.some((row) => row.event === 'mail-limited' && row.limit === 'total'));
  const template = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  assert.ok(template.includes(`FilterPattern: '{ $.message.event = "mail-limited" && $.message.limit = "total" }'`));
  assert.ok(!JSON.stringify([...s.logs, ...ipv6.logs]).includes('@'));
});
test('sessions renew at daily boundary with USER index, expire idle, replace on sign-in and revoke on signout', async () => {
  const s = await setup(),
    old = await s.session();
  s.setNow(initial + 3600);
  assert.equal((await s.call('GET', '/api/me', undefined, old)).response.headers.get('set-cookie'), null);
  s.setNow(initial + 86400);
  const renewed = await s.call('GET', '/api/me', undefined, old);
  assert.match(renewed.response.headers.get('set-cookie')!, /Secure; HttpOnly; SameSite=Lax/);
  assert.equal((await s.store.getSession(auth.digest(old)))?.expires_at, initial + 86400 + auth.SESSION_IDLE);
  assert.equal(
    s.store.memory.read({ pk: 'USER#u', sk: 'SESSION#' + auth.digest(old) })?.expires_at,
    initial + 86400 + auth.SESSION_IDLE
  );
  const login = await s.login(),
    replaced = await s.call('POST', '/api/auth/verify', { token: login.token }, old),
    next = /__Host-rn=([^;]+)/.exec(replaced.response.headers.get('set-cookie')!)![1]!;
  assert.equal((await s.call('GET', '/api/me', undefined, old)).response.status, 401);
  assert.equal((await s.call('POST', '/api/auth/signout', {}, next)).response.status, 200);
  assert.equal((await s.call('GET', '/api/me', undefined, next)).response.status, 401);
  const idle = await s.session();
  s.setNow(initial + 86400 + auth.SESSION_IDLE);
  assert.equal((await s.call('GET', '/api/me', undefined, idle)).response.status, 401);
});
test('file deletion failure preserves note/account and a deletion code cannot authenticate sign-in', async () => {
  const s = await setup(),
    token = await s.session(),
    raw = 'raw/fictional';
  await s.objects.put(raw, Buffer.from('synthetic'), { type: 'message/rfc822' });
  await s.store.putNote('u', '2026-10-12', 'mail', { text: 'Fictional', raw_key: raw });
  s.objects.remove = async () => {
    throw new Error('private storage failure');
  };
  assert.equal((await s.call('DELETE', '/api/days/2026-10-12/notes/mail', undefined, token)).response.status, 503);
  assert.ok(await s.store.note('u', '2026-10-12', 'mail'));
  const deletion = auth.newToken();
  await s.store.putLogin(
    auth.digest(deletion),
    'ada@example.com',
    auth.digest('ada@example.com'),
    auth.digest('654321'),
    initial,
    900,
    'delete'
  );
  assert.equal((await s.call('POST', '/api/auth/verify', { token: deletion })).response.status, 400);
  assert.equal((await s.call('DELETE', '/api/me', { code: '654321' }, token)).response.status, 503);
  assert.ok(await s.store.profile('u'));
  assert.ok(await s.store.note('u', '2026-10-12', 'mail'));
  assert.ok(!JSON.stringify(s.logs).includes('private storage failure'));
});
