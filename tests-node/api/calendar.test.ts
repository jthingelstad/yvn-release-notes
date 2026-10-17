/** The private feed link: made and replaced in a session, read with nothing
 * but the link, gone with the account, never in logs or exports. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app/app.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import * as auth from '../../packages/backend/auth.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
import type { Item } from '../../packages/backend/store-types.ts';
const now = Date.parse('2026-10-13T12:00:00Z') / 1000,
  origin = 'https://notes.example.com';
const birthday = { kind: 'birthday', title: 'Alex', date: '10-20', year: 1976, tag: 'family' };
const place = { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 };
async function fixture() {
  const store = new FakeStore(
      ['u', 'b'].map((uid) => ({
        pk: 'USER#' + uid,
        sk: 'PROFILE',
        email: uid + '@example.com',
        birthday: '1981-06-14',
        tz: 'America/Chicago',
        send_time: '06:00',
        status: 'active'
      })),
      'T',
      1
    ),
    logs: Item[] = [];
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
    log: (f) => logs.push(f)
  };
  const app = createApp({ context: () => ctx });
  async function call(method: string, path: string, value?: unknown, uid = 'u', from = origin) {
    const response = await app.request(path, {
      method,
      headers: { ...(from ? { origin: from } : {}), ...(uid ? { cookie: auth.COOKIE + '=' + uid.repeat(43) } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, data: await response.json() };
  }
  // A calendar app: no cookie, no Origin, nothing but the link.
  async function feed(url: string, method = 'GET') {
    const response = await app.request(url, { method });
    return { status: response.status, response, text: await response.text() };
  }
  return { store, ctx, call, feed, logs };
}
const path = (url: string) => new URL(url).pathname;
test('the link is made on demand, reads the owner’s dates as a calendar, and is replaced or removed', async () => {
  const f = await fixture();
  assert.equal((await f.call('GET', '/api/upcoming')).data.calendar, null);
  await f.call('POST', '/api/upcoming', birthday);
  await f.call('POST', '/api/upcoming', {
    kind: 'trip',
    title: 'Holiday',
    date: '2026-10-20',
    end_date: '2026-10-27',
    place
  });
  await f.call('POST', '/api/upcoming', { kind: 'event', title: 'Other', date: '2026-11-01' }, 'b');
  const made = await f.call('POST', '/api/calendar');
  assert.equal(made.status, 200);
  const url = String(made.data.calendar);
  assert.match(url, /^https:\/\/notes\.example\.com\/api\/calendar\/[a-z2-7]{24}\.ics$/);
  assert.equal((await f.call('GET', '/api/upcoming')).data.calendar, url);
  assert.equal((await f.call('GET', '/api/upcoming', undefined, 'b')).data.calendar, null);
  assert.equal(JSON.stringify(await f.call('GET', '/api/me')).includes('calendar'), false);
  const read = await f.feed(path(url));
  assert.equal(read.status, 200);
  assert.equal(read.response.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(read.response.headers.get('cache-control'), 'no-store');
  assert.equal(read.response.headers.get('set-cookie'), null);
  assert.ok(read.text.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(read.text.includes('SUMMARY:Alex turns 5.0.0\r\nDESCRIPTION:A major release.\\n#family\r\n'));
  assert.ok(read.text.includes('UID:'));
  assert.ok(
    read.text.includes('DTSTART;VALUE=DATE:20261020\r\nDTEND;VALUE=DATE:20261028\r\nSUMMARY:Holiday — Paris\r\n')
  );
  assert.ok(read.text.includes('LOCATION:Paris\\, Ile-de-France\\, France\r\n'));
  assert.equal(read.text.includes('Other'), false, 'another owner’s date');
  assert.equal(read.text.includes('USER#'), false);
  assert.equal(read.text, (await f.feed(path(url))).text, 'an unchanged feed reads the same twice');
  const head = await f.feed(path(url), 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  // Anything but the exact link answers nothing.
  const token = path(url).slice('/api/calendar/'.length, -4),
    other = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.equal((await f.feed('/api/calendar/' + other + '.ics')).status, 404);
  assert.equal((await f.feed(path(url).replace(/\.ics$/, ''))).status, 404);
  assert.equal((await f.feed('/api/calendar/' + 'x'.repeat(24) + '.ics')).status, 404);
  const replaced = await f.call('POST', '/api/calendar');
  assert.notEqual(replaced.data.calendar, url);
  assert.equal((await f.feed(path(url))).status, 404);
  assert.equal((await f.feed(path(String(replaced.data.calendar)))).status, 200);
  assert.equal((await f.call('DELETE', '/api/calendar')).data.ok, true);
  assert.equal((await f.feed(path(String(replaced.data.calendar)))).status, 404);
  assert.equal((await f.call('GET', '/api/upcoming')).data.calendar, null);
  assert.equal((await f.call('DELETE', '/api/calendar')).status, 200, 'removing none is fine');
  assert.equal((await f.call('GET', '/api/export')).data.calendar, undefined);
  const logged = JSON.stringify(f.logs);
  assert.doesNotMatch(logged, /Alex|Holiday|Paris|family|@example/);
  assert.equal(logged.includes(url.slice(-28, -4)), false, 'the token is never logged');
  assert.equal(logged.includes(String(replaced.data.calendar).slice(-28, -4)), false);
  assert.ok(f.logs.some((l) => l.event === 'calendar' && l.action === 'read' && l.user === 'u' && l.events === 6));
  assert.ok(f.logs.some((l) => l.event === 'web' && l.path === '/api/calendar/{token}.ics' && l.status === 404));
});
test('making or removing the link needs the live session, Origin and an account that is not being deleted', async () => {
  const f = await fixture();
  assert.equal((await f.call('POST', '/api/calendar', undefined, '')).status, 401);
  assert.equal((await f.call('DELETE', '/api/calendar', undefined, '')).status, 401);
  assert.equal((await f.call('POST', '/api/calendar', undefined, 'u', 'https://elsewhere.example')).status, 403);
  await f.store.putSession(auth.digest('s'.repeat(43)), { email: 'new@example.com', now, expires: now + 86400 });
  assert.equal((await f.call('POST', '/api/calendar', undefined, 's')).status, 403);
  const url = String((await f.call('POST', '/api/calendar')).data.calendar);
  await f.store.updateProfile('u', { mcp_deleting: true });
  assert.equal((await f.call('POST', '/api/calendar')).status, 403);
  assert.equal((await f.call('DELETE', '/api/calendar')).status, 403);
  assert.equal((await f.feed(path(url))).status, 404, 'a feed stops while the account is being deleted');
  // A stale CALENDAR row the profile no longer names opens nothing.
  await f.store.updateProfile('u', { mcp_deleting: false });
  await f.store.updateProfile('b', { calendar: 'gone' });
  f.store.seed({ pk: 'CALENDAR#' + 'z'.repeat(24), sk: 'CALENDAR', user_id: 'b', created_at: 'x' });
  assert.equal((await f.feed('/api/calendar/' + 'z'.repeat(24) + '.ics')).status, 404);
});
test('purpose-verified account deletion removes the link with the profile', async () => {
  const f = await fixture();
  const url = String((await f.call('POST', '/api/calendar')).data.calendar),
    token = path(url).slice('/api/calendar/'.length, -4);
  await f.store.putLogin(
    auth.digest('d'.repeat(43)),
    'u@example.com',
    auth.digest('u@example.com'),
    auth.digest('222222'),
    now,
    900,
    'delete'
  );
  assert.equal((await f.call('DELETE', '/api/me', { code: '222222' })).status, 200);
  assert.equal(await f.store.profile('u'), null);
  assert.equal(await f.store.getCalendar(token), null);
  assert.equal((await f.feed(path(url))).status, 404);
});
