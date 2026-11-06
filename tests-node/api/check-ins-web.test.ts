/** Check-ins through the owner's session (docs/CHECK-INS.md): reading them
 * whole, naming once or for good, remembered places, deleting, the Activity
 * filter, and that no name or spot reaches a log or a stored row. Fictional
 * account, no Amazon Location. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app/app.ts';
import { spotsFor } from '../../server/app/check-in-routes.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import * as auth from '../../packages/backend/auth.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import { checkInId, checkInKey, STAY_WRITE_MAX, type CheckIn } from '../../packages/domain/check-ins.ts';

const now = Date.parse('2026-10-13T12:00:00Z') / 1000,
  origin = 'https://notes.example.com',
  HOME = { lat: 44.9778, lon: -93.265 },
  NEAR = { lat: 44.978, lon: -93.265 },
  SHOP = { lat: 44.99, lon: -93.2 };

function stop(uid: string, at: string, spot: { lat: number; lon: number }, more: Item = {}): CheckIn {
  const id = checkInId(at, 'ab12');
  return {
    pk: 'USER#' + uid,
    sk: checkInKey(at, id),
    id,
    at,
    arrived: at,
    left: new Date(Date.parse(at) + 3_600_000).toISOString(),
    ...spot,
    accuracy_m: 20,
    source: 'visit',
    day: at.slice(0, 10),
    time_zone: 'America/Chicago',
    district: 'Uptown, Springfield',
    connection: 't1',
    token: 'Phone',
    via: 'token',
    revision: 1,
    ...more
  } as CheckIn;
}

async function fixture(stops: CheckIn[] = []) {
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
      100
    ),
    logs: Item[] = [];
  for (const uid of ['u', 'b'])
    await store.putSession(auth.digest(uid.repeat(43)), { user_id: uid, now, expires: now + 86400 });
  if (stops.length)
    await store.checkInWrites(
      'u',
      stops.map((next) => ({ next })),
      [],
      []
    );
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
      headers: { origin: from, cookie: auth.COOKIE + '=' + uid.repeat(43) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  }
  const rows = () => store.memory.all().filter((r) => r.pk === 'USER#u'),
    activity = () => rows().filter((r) => String(r.sk).startsWith('ACTIVITY#'));
  return { store, call, logs, rows, activity };
}

const A = '2026-10-12T14:00:00.000Z',
  B = '2026-10-12T16:00:00.000Z',
  C = '2026-10-12T20:00:00.000Z';

test('the Map reads every stay, spot and all, with its release, and only its owner does', async () => {
  const f = await fixture([stop('u', A, HOME), stop('u', B, SHOP)]);
  const { status, data } = await f.call('GET', '/api/check-ins');
  assert.equal(status, 200);
  assert.deepEqual(
    data.stays.map((s: Item) => [s.at, s.lat, s.label, s.release]),
    [
      [B, SHOP.lat, 'Uptown, Springfield', data.stays[0].release],
      [A, HOME.lat, 'Uptown, Springfield', data.stays[1].release]
    ]
  );
  assert.match(data.stays[0].release, /^\d+\.\d$/);
  assert.match(data.stays[0].version, /^\d+\.\d\.\d+$/);
  assert.deepEqual((await f.call('GET', '/api/check-ins', undefined, 'b')).data.stays, []);
  const id = data.stays[0].id;
  assert.equal((await f.call('GET', '/api/check-ins/' + id, undefined, 'b')).status, 404);
  assert.equal((await f.call('PUT', '/api/check-ins/' + id, { name: 'X', revision: 1 }, 'b')).status, 404);
  assert.equal((await f.call('DELETE', '/api/check-ins/' + id, undefined, 'b')).status, 404);
  assert.equal((await f.call('DELETE', '/api/check-ins/' + id, undefined, 'u', 'https://else.example')).status, 403);
  assert.equal(f.rows().filter((r) => String(r.sk).startsWith('CHECKIN#')).length, 2);
});

test('one stop reads in the account’s zone when it has none of its own', async () => {
  const f = await fixture([stop('u', A, HOME, { time_zone: undefined })]),
    [stay] = (await f.call('GET', '/api/check-ins')).data.stays;
  assert.equal(stay.time_zone, 'America/Chicago');
});

test('a name goes on this stay alone, on every check-in in it, from the revision read', async () => {
  // Back to back, at one place: one stay, whichever id names it.
  const first = stop('u', A, HOME),
    second = stop('u', '2026-10-12T15:10:00.000Z', NEAR),
    other = stop('u', C, HOME),
    f = await fixture([first, second, other]);
  const { check_in: read } = (await f.call('GET', '/api/check-ins/' + second.id)).data;
  assert.equal(read.id, first.id);
  assert.deepEqual(read.ids, [first.id, second.id]);
  assert.equal(read.revision, 2);
  assert.equal(read.named_by, 'district');

  assert.equal((await f.call('PUT', '/api/check-ins/' + first.id, { name: 'Bakery', revision: 1 })).status, 409);
  assert.equal((await f.call('PUT', '/api/check-ins/' + first.id, { name: ' ', revision: 2 })).status, 400);
  assert.equal((await f.call('PUT', '/api/check-ins/' + first.id, { name: 'a\nb', revision: 2 })).status, 400);
  assert.equal((await f.call('PUT', '/api/check-ins/' + first.id, { revision: 2 })).status, 400);
  const named = await f.call('PUT', '/api/check-ins/' + first.id, { name: ' Corner Bakery ', revision: 2 });
  assert.equal(named.status, 200);
  assert.equal(named.data.check_in.label, 'Corner Bakery');
  assert.equal(named.data.check_in.named_by, 'own');
  assert.equal(named.data.check_in.revision, 4);
  const stays = (await f.call('GET', '/api/check-ins')).data.stays;
  assert.deepEqual(
    stays.map((s: Item) => s.label),
    ['Uptown, Springfield', 'Corner Bakery']
  );
  assert.deepEqual(stays[1].ids, [first.id, second.id]);
  // A name comes off with null, and the neighbourhood is back.
  const off = await f.call('PUT', '/api/check-ins/' + first.id, { name: null, revision: 4 });
  assert.equal(off.data.check_in.label, 'Uptown, Springfield');
  assert.equal(f.activity().filter((r) => r.kind === 'checkin.named').length, 2);
  assert.ok(f.activity().every((r) => r.via === 'web' || r.kind !== 'checkin.named'));
});

test('Remember names every stop near the spot, past and future, and takes this one’s own name off', async () => {
  const here = stop('u', A, HOME, { name: 'First go' }),
    later = stop('u', C, NEAR),
    away = stop('u', B, SHOP),
    f = await fixture([here, away, later]);
  const { data, status } = await f.call('PUT', '/api/check-ins/' + here.id, {
    name: 'Home',
    remember: true,
    revision: 1
  });
  assert.equal(status, 200);
  assert.equal(data.check_in.label, 'Home');
  assert.equal(data.check_in.named_by, 'place');
  assert.equal(data.check_in.name, null);
  const stays = (await f.call('GET', '/api/check-ins')).data.stays;
  assert.deepEqual(
    stays.map((s: Item) => s.label),
    ['Home', 'Uptown, Springfield', 'Home']
  );
  const { places } = (await f.call('GET', '/api/check-ins/places')).data;
  assert.equal(places.length, 1);
  assert.deepEqual(places[0].spots, [HOME]);
  assert.deepEqual(
    f.activity().map((r) => [r.kind, r.change]),
    [['checkin.place', 'added']]
  );
  // A second spot with a name in use joins it, whatever its case.
  const joined = await f.call('PUT', '/api/check-ins/' + away.id, { name: 'HOME', remember: true, revision: 1 });
  assert.equal(joined.data.check_in.label, 'Home');
  const [place] = (await f.call('GET', '/api/check-ins/places')).data.places;
  assert.deepEqual(place.spots, [HOME, SHOP]);
  // Remembered with no name means nothing.
  assert.equal(
    (await f.call('PUT', '/api/check-ins/' + later.id, { name: null, remember: true, revision: 1 })).status,
    400
  );
});

test('remembering a stay keeps every spot it needs to stay whole', () => {
  assert.deepEqual(spotsFor([], [HOME, NEAR]), [HOME]);
  assert.deepEqual(spotsFor([], [HOME, SHOP]), [HOME, SHOP]);
  assert.deepEqual(spotsFor([HOME], [NEAR]), [HOME]);
});

test('a stay too long for one transaction takes no name, and nothing changes', async () => {
  const many = Array.from({ length: STAY_WRITE_MAX + 1 }, (_, i) =>
      stop('u', new Date(Date.parse(A) + i * 60_000).toISOString(), HOME, {
        left: new Date(Date.parse(A) + i * 60_000 + 30_000).toISOString()
      })
    ),
    f = await fixture(many),
    { check_in: read } = (await f.call('GET', '/api/check-ins/' + many[0]!.id)).data;
  assert.equal(read.ids.length, STAY_WRITE_MAX + 1);
  const r = await f.call('PUT', '/api/check-ins/' + many[0]!.id, { name: 'Long', revision: read.revision });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'check-in-stay-long');
  assert.ok(f.rows().every((row) => !row.name));
  // Deleting goes in steps, and takes all of it.
  assert.equal((await f.call('DELETE', '/api/check-ins/' + many[0]!.id)).status, 204);
  assert.equal(f.rows().filter((row) => String(row.sk).startsWith('CHECKIN#')).length, 0);
});

test('renaming and forgetting a remembered place change every stop there', async () => {
  const here = stop('u', A, HOME),
    f = await fixture([here]);
  await f.call('PUT', '/api/check-ins/' + here.id, { name: 'Home', remember: true, revision: 1 });
  await f.call('PUT', '/api/check-ins/' + here.id, { name: 'Other', remember: true, revision: 1 });
  const { places } = (await f.call('GET', '/api/check-ins/places')).data,
    home = places.find((p: Item) => p.name === 'Home');
  assert.deepEqual(
    places.map((p: Item) => p.name),
    ['Home', 'Other']
  );
  assert.equal((await f.call('PUT', '/api/check-ins/places/' + home.id, { name: 'other' })).status, 409);
  assert.equal((await f.call('PUT', '/api/check-ins/places/' + home.id, { name: '' })).status, 400);
  assert.equal((await f.call('PUT', '/api/check-ins/places/p-none', { name: 'X' })).status, 404);
  assert.equal((await f.call('DELETE', '/api/check-ins/places/' + home.id, undefined, 'b')).status, 404);
  assert.equal((await f.call('PUT', '/api/check-ins/places/' + home.id, { name: 'The House' })).status, 200);
  assert.equal((await f.call('DELETE', '/api/check-ins/places/' + home.id)).status, 204);
  assert.deepEqual(
    f
      .activity()
      .filter((r) => r.kind === 'checkin.place')
      .map((r) => r.change)
      .sort(),
    ['added', 'added', 'forgotten', 'renamed']
  );
});

test('Delete goes for one stay, and all of them only when the body says so, leaving the names', async () => {
  const one = stop('u', A, HOME),
    two = stop('u', C, SHOP),
    f = await fixture([one, two]);
  await f.call('PUT', '/api/check-ins/' + one.id, { name: 'Home', remember: true, revision: 1 });
  assert.equal((await f.call('DELETE', '/api/check-ins/' + one.id)).status, 204);
  assert.equal((await f.call('GET', '/api/check-ins/' + one.id)).status, 404);
  assert.equal((await f.call('DELETE', '/api/check-ins', {})).status, 400);
  assert.equal((await f.call('GET', '/api/check-ins')).data.stays.length, 1);
  assert.deepEqual((await f.call('DELETE', '/api/check-ins', { confirm: 'all' })).data, { deleted: 1 });
  assert.equal((await f.call('GET', '/api/check-ins')).data.stays.length, 0);
  assert.equal((await f.call('GET', '/api/check-ins/places')).data.places.length, 1);
  const gone = f.activity().filter((r) => r.kind === 'checkin.deleted');
  assert.deepEqual(gone.map((r) => [r.count, r.all ?? false, r.day ?? null]).sort(), [
    [1, false, '2026-10-12'],
    [1, true, null]
  ]);
  // Nothing to delete leaves no row.
  assert.deepEqual((await f.call('DELETE', '/api/check-ins', { confirm: 'all' })).data, { deleted: 0 });
  assert.equal(f.activity().filter((r) => r.kind === 'checkin.deleted').length, 2);
});

test('no name or spot reaches the log or a stored activity row', async () => {
  const one = stop('u', A, HOME),
    f = await fixture([one]);
  await f.call('PUT', '/api/check-ins/' + one.id, { name: 'Secret Garden', revision: 1 });
  await f.call('PUT', '/api/check-ins/' + one.id, { name: 'Hidden Cove', remember: true, revision: 2 });
  await f.call('GET', '/api/check-ins');
  const said = JSON.stringify([f.logs, f.activity()]);
  for (const word of ['Secret Garden', 'Hidden Cove', String(HOME.lat), String(HOME.lon)])
    assert.ok(!said.includes(word), word);
});

test('Activity says whether there are check-ins, and filters to them', async () => {
  const one = stop('u', A, HOME),
    f = await fixture([one]);
  assert.equal((await f.call('GET', '/api/activity', undefined, 'b')).data.check_ins, false);
  const first = await f.call('GET', '/api/activity');
  assert.equal(first.data.check_ins, true);
  assert.deepEqual(
    first.data.entries.map((e: Item) => e.kind),
    ['checkin']
  );
  await f.call('PUT', '/api/check-ins/' + one.id, { name: 'Home', revision: 1 });
  await f.call('POST', '/api/upcoming', { kind: 'birthday', title: 'Alex', date: '10-20', year: 1976 });
  const all = (await f.call('GET', '/api/activity')).data.entries.map((e: Item) => e.kind),
    only = await f.call('GET', '/api/activity?family=checkin');
  assert.ok(all.includes('upcoming.added'));
  assert.deepEqual(only.data.entries.map((e: Item) => e.kind).sort(), ['checkin', 'checkin.named']);
  assert.equal(only.data.next, null);
  assert.equal(only.data.entries.find((e: Item) => e.kind === 'checkin').label, 'Home');
  assert.equal(JSON.stringify(only.data.entries).includes(String(HOME.lat)), false);
  assert.equal((await f.call('GET', '/api/activity?family=nothing')).status, 400);
  // A later page doesn't ask again.
  const later = await f.call('GET', '/api/activity?before=' + encodeURIComponent('2026-10-13T00:00:00.000Z'));
  assert.equal(later.data.check_ins, undefined);
});
