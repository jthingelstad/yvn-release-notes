import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app/app.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import * as auth from '../../packages/backend/auth.ts';
import {
  LIBRARIAN_AUTH,
  RECHECK_SECONDS,
  UNCONFIRMED_RECHECK_SECONDS,
  LookupError,
  createWeeklyThing,
  standingOf,
  subscribedOf,
  type Standing,
  type Subscribed
} from '../../packages/backend/weekly-thing.ts';

const origin = 'https://notes.example.com',
  now = Date.parse('2026-10-25T12:00:00Z') / 1000,
  city = { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 },
  profile = {
    pk: 'USER#u',
    sk: 'PROFILE',
    email: 'ada@example.com',
    birthday: '1981-06-14',
    tz: 'America/Chicago',
    status: 'active',
    send_time: '06:00',
    city: 'Minneapolis',
    country: 'United States'
  };

// A list that answers from a table and counts what it was asked. Asking to
// be added answers `added` and leaves the address unconfirmed, unless the
// table says how it ends.
function lookup(answers: Record<string, Standing | Error>, adding: Record<string, Subscribed | Error> = {}) {
  const asked: string[] = [],
    subscribed: string[] = [];
  return {
    asked,
    subscribed,
    weeklyThing: {
      async standing(email: string): Promise<Standing> {
        asked.push(email);
        const a = answers[email] ?? 'none';
        if (a instanceof Error) throw a;
        return a;
      },
      async subscribe(email: string): Promise<Subscribed> {
        subscribed.push(email);
        const a = adding[email] ?? { outcome: 'added' };
        if (a instanceof Error) throw a;
        if (a.outcome === 'added') answers[email] = 'unconfirmed';
        return a;
      }
    }
  };
}

async function setup(weeklyThing?: ApiContext['weeklyThing'], stored: Item = profile) {
  const store = new FakeStore([stored, { pk: 'EMAIL#ada@example.com', sk: 'EMAIL', user_id: 'u' }], 'T', 2),
    invocations = new FakeInvocations(),
    logs: Item[] = [],
    member = auth.newToken();
  await store.putSession(auth.digest(member), { user_id: 'u', now, expires: now + auth.SESSION_IDLE });
  const ctx: ApiContext = {
    store,
    objects: new FakeObjects(),
    mail: new FakeMail(),
    invocations,
    origin,
    now,
    from: 'notes@example.com',
    inboundDomain: 'in.example.com',
    senderFunction: 'sender',
    exportFunction: 'export',
    geocode: async () => [city],
    fetchTitle: () => null,
    weatherFetch: async () => ({}),
    log: (f) => logs.push(f),
    ...(weeklyThing ? { weeklyThing } : {})
  };
  const app = createApp({ context: () => ctx, viewer: () => '192.0.2.1' });
  const call = async (method: string, path: string, cookie: string, value?: unknown) => {
    const headers: Record<string, string> = { cookie: `${auth.COOKIE}=${cookie}`, origin };
    if (value !== undefined) headers['content-type'] = 'application/json';
    const r = await app.request(path, { method, headers, ...(value ? { body: JSON.stringify(value) } : {}) });
    return { r, b: (await r.json()) as Item };
  };
  // A verified session for an address with no account yet.
  const newcomer = async (email: string) => {
    const token = auth.newToken();
    await store.putSession(auth.digest(token), { email, now, expires: now + 900 });
    return token;
  };
  const signUp = (token: string) =>
    call('PUT', '/api/me', token, { birthday: '1990-03-02', send_time: '06:00', place: city });
  return { ctx, store, invocations, logs, member, call, newcomer, signUp };
}

test('the Librarian’s answers read as standings', () => {
  assert.equal(standingOf(200, { status: 'premium' }), 'member');
  assert.equal(standingOf(200, { status: 'active' }), 'reader');
  assert.equal(standingOf(200, { status: 'unconfirmed' }), 'unconfirmed');
  assert.equal(standingOf(200, { status: 'not_found' }), 'none');
  assert.equal(standingOf(403, { status: 'inactive', under_review: true }), 'none');
  for (const [status, body] of [
    [403, { status: 'turnstile_failed' }],
    [429, { error: 'Too many access attempts.' }],
    [502, { error: 'Could not validate subscriber status right now.' }],
    [200, { status: 'something new' }]
  ] as const)
    assert.throws(
      () => standingOf(status, body),
      (e: unknown) => e instanceof LookupError && e.status === status
    );

  assert.deepEqual(subscribedOf(200, { status: 'subscribed' }), { outcome: 'added' });
  assert.deepEqual(subscribedOf(200, { status: 'already_subscribed', subscriber_status: 'premium' }), {
    outcome: 'already',
    standing: 'member'
  });
  assert.deepEqual(subscribedOf(200, { status: 'needs_jamie', subscriber_status: 'blocked' }), { outcome: 'review' });
  assert.deepEqual(subscribedOf(200, { status: 'needs_jamie' }), { outcome: 'by-hand' });
  assert.deepEqual(subscribedOf(200, { status: 'resubscribe_unavailable' }), { outcome: 'by-hand' });
  assert.throws(() => subscribedOf(429, { error: 'Too many attempts for that address.' }), LookupError);
  assert.throws(() => subscribedOf(502, { error: 'Could not add that email right now.' }), LookupError);
});

test('the client posts to the Librarian as release-notes, with no key', async () => {
  const seen: { url: string; headers: Headers; body: Item }[] = [];
  let answer: () => Response = () => Response.json({ status: 'premium' });
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) as Item });
    return answer();
  }) as typeof fetch;
  const wt = createWeeklyThing(LIBRARIAN_AUTH, fetcher);
  assert.equal(await wt.standing('a+b@example.com'), 'member');
  assert.equal(seen[0]!.url, 'https://librarian.thingelstad.com/auth');
  assert.deepEqual(seen[0]!.body, { source: 'release-notes', action: 'check', email: 'a+b@example.com' });
  assert.equal(seen[0]!.headers.get('authorization'), null);
  answer = () => Response.json({ status: 'subscribed', subscriber_status: 'unconfirmed' });
  assert.deepEqual(await wt.subscribe('a@example.com'), { outcome: 'added' });
  assert.deepEqual(seen[1]!.body, {
    source: 'release-notes',
    action: 'subscribe',
    email: 'a@example.com',
    attribution: { ref: 'release-notes' }
  });
  answer = () => new Response('<html>Bad gateway</html>', { status: 502 });
  await assert.rejects(wt.standing('a@example.com'), (e: unknown) => e instanceof LookupError && e.status === 502);
});

test('a new address needs the Weekly Thing before an account is made', async () => {
  const wt = lookup({ 'reader@example.com': 'reader', 'pending@example.com': 'unconfirmed' }),
    s = await setup(wt.weeklyThing);

  const stranger = await s.newcomer('stranger@example.com');
  assert.deepEqual((await s.call('GET', '/api/me', stranger)).b, {
    new: true,
    email: 'stranger@example.com',
    weekly_thing: 'none'
  });
  const refused = await s.signUp(stranger);
  assert.equal(refused.r.status, 403);
  assert.equal(refused.b.error, 'weekly-thing');
  assert.equal(await s.store.userForEmail('stranger@example.com'), null);
  assert.equal(s.invocations.calls.length, 0, 'no first email');

  const pending = await s.newcomer('pending@example.com');
  assert.equal((await s.call('GET', '/api/me', pending)).b.weekly_thing, 'unconfirmed');
  assert.equal((await s.signUp(pending)).b.error, 'weekly-thing-unconfirmed');

  const reader = await s.newcomer('reader@example.com');
  const made = await s.signUp(reader);
  assert.equal(made.r.status, 200);
  assert.equal(made.b.weekly_thing, 'reader');
  const uid = String(await s.store.userForEmail('reader@example.com'));
  const stored = (await s.store.profile(uid))!;
  assert.equal(stored.weekly_thing, 'reader');
  assert.equal(stored.weekly_thing_at, '2026-10-25T12:00:00Z');
  assert.equal(s.invocations.calls.length, 1);
  assert.ok(!JSON.stringify(s.logs).includes('@example.com'), 'addresses never reach the log');
});

test('a failed lookup, or no gate, never stops a sign-up', async () => {
  const broken = await setup(lookup({ 'new@example.com': new LookupError(500) }).weeklyThing);
  const token = await broken.newcomer('new@example.com');
  assert.deepEqual((await broken.call('GET', '/api/me', token)).b, { new: true, email: 'new@example.com' });
  const made = await broken.signUp(token);
  assert.equal(made.r.status, 200);
  assert.equal(made.b.weekly_thing, undefined);
  assert.ok(broken.logs.some((l) => l.event === 'weekly-thing-error' && l.status === 500));

  const open = await setup();
  assert.equal((await open.signUp(await open.newcomer('new@example.com'))).r.status, 200);
});

test('an account made before the gate keeps everything and is looked at every nine days', async () => {
  const wt = lookup({ 'ada@example.com': 'none' }),
    s = await setup(wt.weeklyThing);
  const first = await s.call('GET', '/api/me', s.member);
  assert.equal(first.r.status, 200);
  assert.equal(first.b.weekly_thing, 'none', 'shown, never refused');
  assert.equal((await s.store.profile('u'))!.weekly_thing_at, '2026-10-25T12:00:00Z');
  await s.call('GET', '/api/me', s.member);
  assert.equal(wt.asked.length, 1, 'not asked again within nine days');

  s.ctx.now = now + RECHECK_SECONDS;
  wt.weeklyThing.standing = async (email) => {
    wt.asked.push(email);
    return 'member';
  };
  assert.equal((await s.call('GET', '/api/me', s.member)).b.weekly_thing, 'member');
  assert.equal(wt.asked.length, 2);

  s.ctx.now += RECHECK_SECONDS;
  wt.weeklyThing.standing = async () => {
    throw new LookupError(502);
  };
  const kept = await s.call('GET', '/api/me', s.member);
  assert.equal(kept.r.status, 200);
  assert.equal(kept.b.weekly_thing, 'member', 'a failed lookup keeps what was known');
});

test('a sign-in looks again, so a membership taken up since shows at once', async () => {
  const wt = lookup({ 'ada@example.com': 'reader' }),
    s = await setup(wt.weeklyThing);
  assert.equal((await s.call('GET', '/api/me', s.member)).b.weekly_thing, 'reader');
  // Renewed: the session already open doesn't ask again before nine days.
  wt.weeklyThing.standing = async (email) => {
    wt.asked.push(email);
    return 'member';
  };
  s.ctx.now = now + 600;
  assert.equal((await s.call('GET', '/api/me', s.member)).b.weekly_thing, 'reader');
  assert.equal(wt.asked.length, 1);

  // Signing in again (a session made now, as /api/auth/verify makes it) does, once.
  const again = auth.newToken();
  await s.store.putSession(auth.digest(again), { user_id: 'u', now: s.ctx.now, expires: s.ctx.now + 86400 });
  assert.equal((await s.call('GET', '/api/me', again)).b.weekly_thing, 'member');
  assert.equal(wt.asked.length, 2);
  assert.deepEqual(
    (await s.store.activityAll('u')).filter((r) => r.kind === 'badge.earned').map((r) => r.badge),
    ['giving-2026']
  );
  s.ctx.now += 60;
  await s.call('GET', '/api/me', again);
  await s.call('GET', '/api/me', s.member);
  assert.equal(wt.asked.length, 2, 'each sign-in asks once, and an older session not again');
});

test('a new address can ask to be added, and then waits on one email', async () => {
  const wt = lookup({}, { 'flagged@example.com': { outcome: 'review' }, 'gone@example.com': { outcome: 'by-hand' } }),
    s = await setup(wt.weeklyThing);
  const signedOut = await s.call('POST', '/api/me/weekly-thing', 'nobody', {});
  assert.equal(signedOut.r.status, 401);
  assert.equal(wt.subscribed.length, 0);

  const stranger = await s.newcomer('stranger@example.com');
  const added = await s.call('POST', '/api/me/weekly-thing', stranger, {});
  assert.equal(added.r.status, 200);
  assert.deepEqual(added.b, { weekly_thing: 'unconfirmed' });
  assert.deepEqual(wt.subscribed, ['stranger@example.com'], 'the verified address, never one sent');
  assert.equal((await s.call('GET', '/api/me', stranger)).b.weekly_thing, 'unconfirmed');
  assert.equal((await s.signUp(stranger)).b.error, 'weekly-thing-unconfirmed');

  const flagged = await s.call('POST', '/api/me/weekly-thing', await s.newcomer('flagged@example.com'), {});
  assert.equal(flagged.r.status, 409);
  assert.equal(flagged.b.error, 'weekly-thing-review');
  const gone = await s.call('POST', '/api/me/weekly-thing', await s.newcomer('gone@example.com'), {});
  assert.equal(gone.b.error, 'weekly-thing-by-hand');
  assert.ok(s.logs.some((l) => l.event === 'weekly-thing-subscribe' && l.outcome === 'added'));
  assert.ok(!JSON.stringify(s.logs).includes('@example.com'), 'addresses never reach the log');
});

test('a list that is down asks the reader to try again', async () => {
  const s = await setup(lookup({}, { 'new@example.com': new LookupError(502) }).weeklyThing);
  const busy = await s.call('POST', '/api/me/weekly-thing', await s.newcomer('new@example.com'), {});
  assert.equal(busy.r.status, 503);
  assert.equal(busy.b.error, 'weekly-thing-busy');
  assert.ok(s.logs.some((l) => l.event === 'weekly-thing-subscribe-error' && l.status === 502));
  const off = await setup();
  assert.equal(
    (await off.call('POST', '/api/me/weekly-thing', await off.newcomer('new@example.com'), {})).r.status,
    404
  );
});

test('an account that asks to be added is looked at again soon after', async () => {
  const wt = lookup({ 'ada@example.com': 'none' }),
    s = await setup(wt.weeklyThing);
  assert.equal((await s.call('GET', '/api/me', s.member)).b.weekly_thing, 'none');
  assert.deepEqual((await s.call('POST', '/api/me/weekly-thing', s.member, {})).b, { weekly_thing: 'unconfirmed' });
  const stored = (await s.store.profile('u'))!;
  assert.equal(stored.weekly_thing, 'unconfirmed');
  assert.equal(stored.weekly_thing_at, '2026-10-25T12:00:00Z');
  assert.equal(wt.asked.length, 1);

  wt.weeklyThing.standing = async (email) => {
    wt.asked.push(email);
    return 'reader';
  };
  assert.equal((await s.call('GET', '/api/me', s.member)).b.weekly_thing, 'unconfirmed', 'not straight away');
  s.ctx.now = now + UNCONFIRMED_RECHECK_SECONDS;
  assert.equal((await s.call('GET', '/api/me', s.member)).b.weekly_thing, 'reader');
  assert.equal(wt.asked.length, 2);
});

test('a Supporting Member records the year given, with its badge, at sign-up and at each look', async () => {
  const wt = lookup({ 'member@example.com': 'member', 'ada@example.com': 'member' }),
    s = await setup(wt.weeklyThing);
  assert.equal((await s.signUp(await s.newcomer('member@example.com'))).r.status, 200);
  const uid = String(await s.store.userForEmail('member@example.com'));
  assert.deepEqual((await s.store.profile(uid))!.giving, { 2026: { first: '2026-10-25', last: '2026-10-25' } });
  assert.deepEqual(
    (await s.store.activityAll(uid)).filter((r) => r.kind === 'badge.earned').map((r) => [r.badge, r.via, r.name]),
    [['giving-2026', 'weekly-thing', 'Supported Signal']]
  );

  // An account from before the gate is looked at on a visit, then nine days on: the year widens, one row.
  await s.call('GET', '/api/me', s.member);
  assert.deepEqual((await s.store.profile('u'))!.giving, { 2026: { first: '2026-10-25', last: '2026-10-25' } });
  s.ctx.now = now + RECHECK_SECONDS;
  await s.call('GET', '/api/me', s.member);
  assert.deepEqual((await s.store.profile('u'))!.giving, { 2026: { first: '2026-10-25', last: '2026-11-03' } });
  assert.equal((await s.store.activityAll('u')).filter((r) => r.kind === 'badge.earned').length, 1);
  const shelf = await s.call('GET', '/api/badges', s.member);
  assert.ok((shelf.b.earned as Item[]).some((e) => e.key === 'giving-2026' && e.shelf === 'giving'));
  assert.ok(!JSON.stringify(s.logs).includes('@example.com'));
});

test('a reader records no giving, and "Show badges" off records the year with no row', async () => {
  const reader = await setup(lookup({ 'ada@example.com': 'reader' }).weeklyThing);
  await reader.call('GET', '/api/me', reader.member);
  assert.ok(!('giving' in (await reader.store.profile('u'))!));

  const off = await setup(lookup({ 'ada@example.com': 'member' }).weeklyThing, { ...profile, badges: false });
  await off.call('GET', '/api/me', off.member);
  assert.ok((await off.store.profile('u'))!.giving);
  assert.equal((await off.store.activityAll('u')).filter((r) => r.kind === 'badge.earned').length, 0);
});
