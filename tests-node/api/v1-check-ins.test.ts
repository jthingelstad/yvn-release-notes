/** Check-ins through `/v1` (API 1.18.0, docs/CHECK-INS.md) as the capture
 * function runs them: a phone's repeat reports landing in one record, stops
 * with no arrival, the names, the merge, scope refusals, and the rule that no
 * spot or name goes into the log or a stored activity row. Fictional account,
 * fake Amazon Location. */
import { test } from 'node:test';
import { STAY_WRITE_MAX } from '../../packages/domain/check-ins.ts';
import assert from 'node:assert/strict';
import { createMcpApp, type McpOptions } from '../../server/mcp/app.ts';
import { captureNote, type CaptureContext } from '../../workers/capture.ts';
import { apiReceiptKey, Tokens, V1_LIMITS } from '../../packages/backend/tokens.ts';
import { build, markdown } from '../../packages/backend/export.ts';
import { checkInKey } from '../../packages/domain/check-ins.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { fixture, ORIGIN } from '../oauth/fixtures.ts';

const HOME = { lat: 44.9778, lon: -93.265 },
  NEAR = { lat: 44.978, lon: -93.265 },
  SHOP = { lat: 44.99, lon: -93.2 };
const ARRIVE = '2026-10-12T14:00:00Z',
  LEAVE = '2026-10-12T15:00:00Z';

function setup() {
  const logs: OAuthRow[] = [],
    asked: OAuthRow[] = [],
    base = fixture();
  let naming: 'ok' | 'fail' | 'none' = 'ok';
  const ctx = {
      ...base,
      nameSpot: async (spot: { lat: number; lon: number }) => {
        asked.push(spot);
        if (naming === 'fail') throw new Error('Location is away');
        if (naming === 'none') return null;
        return { city: 'Springfield', region: 'MN', country: 'United States', district: 'Uptown', nearby: [] };
      }
    } as unknown as CaptureContext,
    options: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: (f) => logs.push(f) }),
      log: (f) => logs.push(f)
    };
  return {
    ctx,
    base,
    logs,
    asked,
    app: createMcpApp(options),
    naming: (how: typeof naming) => (naming = how),
    rows: () => base.store.memory.all().filter((r) => r.pk === 'USER#u')
  };
}
type Setup = ReturnType<typeof setup>;
async function make(s: Setup, scopes = ['notes:write', 'activity', 'notes:all'], name = 'Phone') {
  return (await new Tokens({ store: s.base.store, origin: s.base.origin, now: s.base.now }).make('u', {
    name,
    scopes,
    expiry: 'never'
  })) as OAuthRow & { token: string; id: string };
}
let keys = 0;
async function call(s: Setup, token: string, method: string, path: string, body?: unknown, key?: string) {
  const response = await s.app.request(ORIGIN + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'idempotency-key': key ?? `k${++keys}` })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as OAuthRow, response };
}
const report = (more: OAuthRow = {}) => ({
  arrived: ARRIVE,
  left: null,
  ...HOME,
  accuracy_m: 20,
  time_zone: 'America/Chicago',
  source: 'visit',
  ...more
});
const checkIns = (s: Setup) => s.rows().filter((r) => String(r.sk).startsWith('CHECKIN#'));
const shown = (r: { json: OAuthRow }) => r.json.check_in as OAuthRow;
const failed = (r: { json: OAuthRow }) => r.json.error as OAuthRow;

test('arrival then departure land in one record, 201 and then 200', async () => {
  const s = setup(),
    t = await make(s),
    first = await call(s, t.token, 'POST', '/v1/check-ins', report());
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(shown(first).left, null);
  assert.equal(shown(first).label, 'Uptown, Springfield');
  assert.equal(shown(first).named_by, 'district');
  assert.equal(shown(first).day, '2026-10-12');
  assert.equal(first.response.headers.get('ratelimit-limit'), String(V1_LIMITS.lookups));
  assert.equal(first.response.headers.get('ratelimit-remaining'), String(V1_LIMITS.lookups - 1));
  const second = await call(s, t.token, 'POST', '/v1/check-ins', report({ left: LEAVE }));
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(shown(second).id, shown(first).id);
  assert.equal(shown(second).left, '2026-10-12T15:00:00.000Z');
  const stored = checkIns(s);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.revision, 2);
  // One paid lookup, on arrival.
  assert.equal(s.asked.length, 1);
  // Amazon Location is told the coordinates alone.
  assert.deepEqual(Object.keys(s.asked[0]!).sort(), ['lat', 'lon']);
});

test('a report sent twice changes nothing, and a late arrival-only one keeps its leaving', async () => {
  const s = setup(),
    t = await make(s);
  await call(s, t.token, 'POST', '/v1/check-ins', report({ left: LEAVE }));
  const again = await call(s, t.token, 'POST', '/v1/check-ins', report({ left: LEAVE }));
  assert.equal(again.status, 200);
  assert.equal(checkIns(s)[0]!.revision, 1);
  const stale = await call(s, t.token, 'POST', '/v1/check-ins', report());
  assert.equal(stale.status, 200);
  assert.equal(shown(stale).left, '2026-10-12T15:00:00.000Z');
  assert.equal(checkIns(s).length, 1);
});

test('the arrival matches to the second', async () => {
  const s = setup(),
    t = await make(s);
  await call(s, t.token, 'POST', '/v1/check-ins', report({ arrived: '2026-10-12T14:00:00.100Z' }));
  const same = await call(
    s,
    t.token,
    'POST',
    '/v1/check-ins',
    report({ arrived: '2026-10-12T14:00:00.900Z', left: LEAVE })
  );
  assert.equal(same.status, 200);
  const other = await call(
    s,
    t.token,
    'POST',
    '/v1/check-ins',
    report({ arrived: '2026-10-12T14:00:01Z', left: LEAVE })
  );
  assert.equal(other.status, 201);
  assert.equal(checkIns(s).length, 2);
});

test('an Idempotency-Key answers its first result, and refuses another request', async () => {
  const s = setup(),
    t = await make(s),
    first = await call(s, t.token, 'POST', '/v1/check-ins', report(), 'same'),
    replay = await call(s, t.token, 'POST', '/v1/check-ins', report(), 'same');
  assert.equal(replay.status, 201);
  assert.equal(replay.response.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(replay.json, first.json);
  const other = await call(s, t.token, 'POST', '/v1/check-ins', report({ left: LEAVE }), 'same');
  assert.equal(failed(other).code, 'idempotency_mismatch');
});

test('a stop with no arrival begins when it left, and repeats as one', async () => {
  const s = setup(),
    t = await make(s),
    body = report({ arrived: null, left: LEAVE }),
    first = await call(s, t.token, 'POST', '/v1/check-ins', body);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(shown(first).arrived, null);
  assert.equal(shown(first).at, '2026-10-12T15:00:00.000Z');
  assert.equal((await call(s, t.token, 'POST', '/v1/check-ins', body)).status, 200);
  assert.equal(checkIns(s).length, 1);
  // Another departure from the same second-less start is its own stop.
  assert.equal(
    (await call(s, t.token, 'POST', '/v1/check-ins', report({ arrived: null, left: '2026-10-12T16:00:00Z' }))).status,
    201
  );
});

test('a tap is its moment, or when it was heard, and is never continued', async () => {
  const s = setup(),
    t = await make(s),
    body = report({ source: 'tap' });
  assert.equal((await call(s, t.token, 'POST', '/v1/check-ins', body)).status, 201);
  assert.equal((await call(s, t.token, 'POST', '/v1/check-ins', body)).status, 201);
  assert.equal(checkIns(s).length, 2);
  const heard = await call(s, t.token, 'POST', '/v1/check-ins', { ...HOME, source: 'tap' });
  assert.equal(heard.status, 201, JSON.stringify(heard.json));
  assert.equal(shown(heard).at, '2026-10-13T12:00:00.000Z');
  assert.equal(shown(heard).arrived, null);
  assert.equal(shown(heard).time_zone, 'America/Chicago');
  const left = await call(s, t.token, 'POST', '/v1/check-ins', report({ source: 'tap', left: LEAVE }));
  assert.equal(failed(left).field, 'left');
});

test('bad reports are refused with the usual shape', async () => {
  const s = setup(),
    t = await make(s),
    refused = async (body: OAuthRow, code: string, field: string) => {
      const r = await call(s, t.token, 'POST', '/v1/check-ins', body);
      assert.equal(failed(r).code, code, JSON.stringify(r.json));
      assert.equal(failed(r).field, field, JSON.stringify(r.json));
    };
  await refused(report({ lat: 91 }), 'invalid_request', 'lat');
  await refused(report({ lon: 'east' }), 'invalid_request', 'lat');
  await refused(report({ source: 'gps' }), 'invalid_request', 'source');
  await refused(report({ arrived: '2026-02-30T10:00:00Z' }), 'invalid_request', 'arrived');
  await refused(report({ arrived: 'yesterday' }), 'invalid_request', 'arrived');
  await refused(report({ left: '2026-10-12T13:00:00Z' }), 'invalid_request', 'left');
  await refused(report({ arrived: '2026-10-20T12:00:01Z' }), 'invalid_request', 'arrived');
  await refused(report({ arrived: '1975-01-01T00:00:00Z' }), 'date_out_of_range', 'arrived');
  await refused(report({ arrived: null, left: null }), 'invalid_request', 'arrived');
  await refused(report({ time_zone: 'Mars/Base' }), 'invalid_request', 'time_zone');
  await refused(report({ altitude: 3 }), 'invalid_request', 'altitude');
  assert.equal(checkIns(s).length, 0);
  // A week ahead is a phone's clock; older times are a phone offline.
  assert.equal(
    (await call(s, t.token, 'POST', '/v1/check-ins', report({ arrived: '2026-10-20T12:00:00Z' }))).status,
    201
  );
  assert.equal(
    (await call(s, t.token, 'POST', '/v1/check-ins', report({ arrived: '2020-01-01T12:00:00Z' }))).status,
    201
  );
});

test('scopes: add needs notes:write, reading activity, and places and delete-all notes:all', async () => {
  const s = setup(),
    writer = await make(s, ['notes:write'], 'Writer'),
    reader = await make(s, ['activity'], 'Reader');
  assert.equal((await call(s, writer.token, 'POST', '/v1/check-ins', report())).status, 201);
  assert.equal(failed(await call(s, writer.token, 'GET', '/v1/check-ins')).code, 'scope_required');
  assert.equal(failed(await call(s, writer.token, 'GET', '/v1/check-ins/places')).code, 'scope_required');
  assert.equal((await call(s, reader.token, 'GET', '/v1/check-ins')).status, 200);
  assert.equal((await call(s, reader.token, 'GET', '/v1/check-ins/places')).status, 200);
  assert.equal(failed(await call(s, reader.token, 'POST', '/v1/check-ins', report())).code, 'scope_required');
  for (const [method, path, body] of [
    ['DELETE', '/v1/check-ins?confirm=all'],
    ['POST', '/v1/check-ins/places', { name: 'Home', ...HOME }],
    ['PATCH', '/v1/check-ins/places/p-a', { name: 'Home' }],
    ['PATCH', '/v1/check-ins/places/p-a', { ignored: true }],
    ['DELETE', '/v1/check-ins/places/p-a'],
    ['DELETE', '/v1/check-ins/places/p-a/check-ins?count=0'],
    ['GET', '/v1/check-ins/places/p-a']
  ] as const)
    assert.equal(failed(await call(s, writer.token, method, path, body)).code, 'scope_required', path);
  // Counting what is at a place is a read of the log; deleting it is not.
  assert.equal(failed(await call(s, reader.token, 'GET', '/v1/check-ins/places/p-a')).code, 'not_found');
  assert.equal(
    failed(await call(s, reader.token, 'DELETE', '/v1/check-ins/places/p-a/check-ins?count=0')).code,
    'scope_required'
  );
});

test('a token changes its own check-ins, and any with notes:all', async () => {
  const s = setup(),
    mine = await make(s, ['notes:write', 'activity'], 'Mine'),
    other = await make(s, ['notes:write', 'activity'], 'Other'),
    all = await make(s, ['notes:write', 'notes:all', 'activity'], 'All'),
    id = String(shown(await call(s, mine.token, 'POST', '/v1/check-ins', report())).id),
    named = await call(s, other.token, 'PATCH', `/v1/check-ins/${id}`, { name: 'Lunch', revision: 1 });
  assert.equal(failed(named).code, 'not_yours');
  assert.equal(failed(await call(s, other.token, 'DELETE', `/v1/check-ins/${id}`)).code, 'not_yours');
  const own = await call(s, mine.token, 'PATCH', `/v1/check-ins/${id}`, { name: 'Lunch', revision: 1 });
  assert.equal(own.status, 200, JSON.stringify(own.json));
  assert.equal(shown(own).label, 'Lunch');
  assert.equal(shown(own).named_by, 'own');
  assert.equal(
    (await call(s, all.token, 'PATCH', `/v1/check-ins/${id}`, { name: 'Dinner', revision: shown(own).revision }))
      .status,
    200
  );
  assert.equal((await call(s, all.token, 'DELETE', `/v1/check-ins/${id}`)).status, 204);
  assert.equal(checkIns(s).length, 0);
});

test('a name goes with the revision read, and null takes it away', async () => {
  const s = setup(),
    t = await make(s),
    id = String(shown(await call(s, t.token, 'POST', '/v1/check-ins', report())).id),
    path = `/v1/check-ins/${id}`;
  assert.equal(failed(await call(s, t.token, 'PATCH', path, { name: 'A' })).field, 'revision');
  assert.equal(failed(await call(s, t.token, 'PATCH', path, { revision: 1 })).field, 'name');
  assert.equal(failed(await call(s, t.token, 'PATCH', path, { name: 'x\ny', revision: 1 })).field, 'name');
  const stale = await call(s, t.token, 'PATCH', path, { name: 'A', revision: 9 });
  assert.equal(failed(stale).code, 'revision_mismatch');
  const named = await call(s, t.token, 'PATCH', path, { name: 'A', revision: 1 }),
    cleared = await call(s, t.token, 'PATCH', path, { name: null, revision: shown(named).revision });
  assert.equal(cleared.status, 200);
  assert.equal(shown(cleared).name, null);
  assert.equal(shown(cleared).named_by, 'district');
  assert.equal(failed(await call(s, t.token, 'DELETE', '/v1/check-ins/c1-ab')).code, 'not_found');
});

test('remembered places name every stop at once, and forgetting puts the neighbourhood back', async () => {
  const s = setup(),
    t = await make(s);
  await call(s, t.token, 'POST', '/v1/check-ins', report({ left: LEAVE }));
  const made = await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const place = made.json.place as OAuthRow,
    list = async () => (await call(s, t.token, 'GET', '/v1/check-ins')).json.items as OAuthRow[];
  assert.equal((await list())[0]!.label, 'Home');
  assert.equal((await list())[0]!.named_by, 'place');
  assert.equal((await list())[0]!.place, place.id);
  // Nothing about the place went on the check-in.
  assert.equal(checkIns(s)[0]!.name, null);
  // A second spot joins by name, ignoring case; the same spot adds nothing.
  const joined = await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'HOME', ...SHOP });
  assert.equal(joined.status, 200);
  assert.equal((joined.json.place as OAuthRow).id, place.id);
  assert.equal(((joined.json.place as OAuthRow).spots as unknown[]).length, 2);
  await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'home', ...SHOP });
  const all = (await call(s, t.token, 'GET', '/v1/check-ins/places')).json.places as OAuthRow[];
  assert.equal(all.length, 1);
  assert.equal((all[0]!.spots as unknown[]).length, 2);
  // Renaming changes all, a name in use is refused.
  await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Work', lat: 1, lon: 1 });
  const taken = await call(s, t.token, 'PATCH', `/v1/check-ins/places/${String(place.id)}`, { name: 'work' });
  assert.equal(failed(taken).field, 'name');
  const renamed = await call(s, t.token, 'PATCH', `/v1/check-ins/places/${String(place.id)}`, { name: 'Our home' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal((await list())[0]!.label, 'Our home');
  // Forgetting.
  assert.equal((await call(s, t.token, 'DELETE', `/v1/check-ins/places/${String(place.id)}`)).status, 204);
  assert.equal((await list())[0]!.label, 'Uptown, Springfield');
  assert.equal(failed(await call(s, t.token, 'DELETE', `/v1/check-ins/places/${String(place.id)}`)).code, 'not_found');
});

test('an account remembers up to 200 names', async () => {
  const s = setup(),
    t = await make(s);
  for (let i = 0; i < 200; i++)
    s.base.store.memory.seed({
      pk: 'USER#u',
      sk: `NAMEDPLACE#p-${i}`,
      id: `p-${i}`,
      name: `Place ${i}`,
      spots: [{ lat: 1, lon: 1 }],
      revision: 1
    });
  const over = await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'One more', ...HOME });
  assert.equal(failed(over).field, 'name');
  assert.equal((await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'place 7', ...HOME })).status, 200);
});

test('back-to-back stops read as one, and naming or deleting takes them all', async () => {
  const s = setup(),
    t = await make(s),
    post = (body: OAuthRow) => call(s, t.token, 'POST', '/v1/check-ins', body);
  await post(report({ arrived: '2026-10-12T14:00:00Z', left: '2026-10-12T14:30:00Z' }));
  await post(report({ arrived: '2026-10-12T14:45:00Z', left: '2026-10-12T15:30:00Z', ...NEAR }));
  await post(report({ arrived: '2026-10-12T15:31:00Z', left: '2026-10-12T16:00:00Z', ...SHOP }));
  const items = (await call(s, t.token, 'GET', '/v1/check-ins')).json.items as OAuthRow[];
  assert.equal(items.length, 2);
  assert.equal(items[0]!.arrived, '2026-10-12T15:31:00.000Z');
  const stay = items[1]!;
  assert.equal((stay.ids as string[]).length, 2);
  assert.equal(stay.arrived, '2026-10-12T14:00:00.000Z');
  assert.equal(stay.left, '2026-10-12T15:30:00.000Z');
  // Either id names the stay, and it stays one once named.
  const second = (stay.ids as string[])[1]!,
    named = await call(s, t.token, 'PATCH', `/v1/check-ins/${second}`, { name: 'Lunch', revision: stay.revision });
  assert.equal(named.status, 200, JSON.stringify(named.json));
  const after = (await call(s, t.token, 'GET', '/v1/check-ins')).json.items as OAuthRow[];
  assert.equal(after.length, 2);
  assert.equal(after[1]!.label, 'Lunch');
  assert.equal((await call(s, t.token, 'DELETE', `/v1/check-ins/${String(stay.id)}`)).status, 204);
  assert.equal(checkIns(s).length, 1);
  const log = (await call(s, t.token, 'GET', '/v1/activity?kinds=checkin')).json.items as OAuthRow[],
    deleted = log.find((r) => r.kind === 'checkin.deleted')!;
  assert.equal(deleted.count, 2);
  assert.equal(deleted.day, '2026-10-12');
});

test('pages hold whole stays, however they fall, and go by when a stay began', async () => {
  const s = setup(),
    t = await make(s),
    post = (body: OAuthRow) => call(s, t.token, 'POST', '/v1/check-ins', body);
  // Three stays: 9th (one), 10th (two merged, past midnight's edge for no one), 11th.
  await post(report({ arrived: '2026-10-09T14:00:00Z', left: '2026-10-09T15:00:00Z', ...SHOP }));
  await post(report({ arrived: '2026-10-10T14:00:00Z', left: '2026-10-10T15:00:00Z' }));
  await post(report({ arrived: '2026-10-10T15:10:00Z', left: '2026-10-10T16:00:00Z' }));
  await post(report({ arrived: '2026-10-11T14:00:00Z', left: '2026-10-11T15:00:00Z', ...SHOP }));
  const walk: OAuthRow[] = [];
  let next: unknown = null,
    pages = 0;
  do {
    const path = '/v1/check-ins?limit=1' + (next ? `&before=${encodeURIComponent(String(next))}` : ''),
      r = await call(s, t.token, 'GET', path);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    walk.push(...(r.json.items as OAuthRow[]));
    next = r.json.next;
  } while (next && ++pages < 10);
  assert.deepEqual(
    walk.map((w) => (w.ids as string[]).length),
    [1, 2, 1]
  );
  assert.equal(walk[1]!.left, '2026-10-10T16:00:00.000Z');
  // By the account's days (Chicago), both ends in.
  const one = (await call(s, t.token, 'GET', '/v1/check-ins?from=2026-10-10&to=2026-10-10')).json;
  assert.equal((one.items as OAuthRow[]).length, 1);
  assert.equal(((one.items as OAuthRow[])[0]!.ids as string[]).length, 2);
  assert.equal(one.next, null);
  assert.equal(
    failed(await call(s, t.token, 'GET', '/v1/check-ins?from=2026-01-01&to=2026-10-10')).code,
    'range_too_wide'
  );
  assert.equal(failed(await call(s, t.token, 'GET', '/v1/check-ins?before=nope')).field, 'before');
  assert.equal(failed(await call(s, t.token, 'GET', '/v1/check-ins?limit=0')).field, 'limit');
});

test('a stay split by a day range still reads whole, on the day it began', async () => {
  const s = setup(),
    t = await make(s),
    post = (body: OAuthRow) => call(s, t.token, 'POST', '/v1/check-ins', body);
  // Chicago's midnight falls between them.
  await post(report({ arrived: '2026-10-11T04:00:00Z', left: '2026-10-11T04:50:00Z' }));
  await post(report({ arrived: '2026-10-11T05:10:00Z', left: '2026-10-11T06:00:00Z' }));
  const earlier = (await call(s, t.token, 'GET', '/v1/check-ins?from=2026-10-10&to=2026-10-10')).json
      .items as OAuthRow[],
    later = (await call(s, t.token, 'GET', '/v1/check-ins?from=2026-10-11&to=2026-10-11')).json.items as OAuthRow[];
  assert.equal(earlier.length, 1);
  assert.equal((earlier[0]!.ids as string[]).length, 2);
  assert.equal(earlier[0]!.left, '2026-10-11T06:00:00.000Z');
  assert.equal(later.length, 0);
});

test('the activity log has a row for each stay, with no spot, and it goes with the check-in', async () => {
  const s = setup(),
    t = await make(s),
    first = await call(s, t.token, 'POST', '/v1/check-ins', report({ left: '2026-10-12T14:30:00Z' }));
  await call(s, t.token, 'POST', '/v1/check-ins', report({ arrived: '2026-10-12T14:40:00Z', left: LEAVE }));
  await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME });
  const rows = (await call(s, t.token, 'GET', '/v1/activity?kinds=checkin')).json.items as OAuthRow[],
    row = rows.find((r) => r.kind === 'checkin')!;
  assert.equal(rows.filter((r) => r.kind === 'checkin').length, 1);
  assert.equal(row.checkin, shown(first).id);
  assert.equal(row.label, 'Home');
  assert.equal(row.arrived, '2026-10-12T14:00:00.000Z');
  assert.equal(row.left, '2026-10-12T15:00:00.000Z');
  assert.equal(row.merged, 2);
  assert.equal(row.source, 'visit');
  assert.equal(row.token_id, t.id);
  for (const hidden of ['lat', 'lon', 'accuracy_m', 'district', 'name', 'stay']) assert.ok(!(hidden in row), hidden);
  // No stored row of the log holds a spot or a name.
  const stored = JSON.stringify(s.rows().filter((r) => String(r.sk).startsWith('ACTIVITY#')));
  for (const word of ['44.97', '93.26', 'Home', 'Uptown', '"lat"']) assert.ok(!stored.includes(word), word);
  // Deleting takes the row with it.
  await call(s, t.token, 'DELETE', '/v1/check-ins?confirm=all');
  const left = (await call(s, t.token, 'GET', '/v1/activity?kinds=checkin')).json.items as OAuthRow[];
  assert.equal(left.filter((r) => r.kind === 'checkin').length, 0);
  assert.equal(left.find((r) => r.kind === 'checkin.deleted')?.count, 2);
});

test('a page of the log reads on past the rows a stay absorbs, and each page says if more remain', async () => {
  const s = setup(),
    t = await make(s),
    post = (body: OAuthRow) => call(s, t.token, 'POST', '/v1/check-ins', body),
    hour = (h: number, m = 0) => `2026-10-12T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  // A long stay of five reports, and an earlier stop elsewhere.
  await post(report({ arrived: hour(8), left: hour(9), ...SHOP }));
  for (const h of [10, 11, 12, 13, 14]) await post(report({ arrived: hour(h), left: hour(h, 50) }));
  // The token's own row comes first, made after these began.
  const page = await s.base.store.activity('u', { limit: 2 });
  assert.equal(page.rows.length, 2);
  assert.equal(page.more, true);
  assert.equal(page.rows[1]!.merged, 5);
  assert.equal(page.rows[1]!.left, hour(14, 50));
  const cursor = String(page.rows[1]!.sk).slice('ACTIVITY#'.length),
    older = await s.base.store.activity('u', { before: cursor, limit: 1 });
  assert.equal(older.rows.length, 1);
  assert.equal(older.rows[0]!.arrived, hour(8));
  assert.equal(older.more, false);
  // A page beginning inside the stay still drops what the stay absorbed.
  const mid = await s.base.store.activity('u', { before: `${hour(12, 30)}`, limit: 5 });
  assert.deepEqual(
    mid.rows.map((r) => r.arrived),
    [hour(10), hour(8)]
  );
  assert.equal(mid.rows[0]!.left, hour(14, 50));
});

test('past the day’s lookups a stop is still saved, with no neighbourhood', async () => {
  const s = setup(),
    t = await make(s),
    day = Math.floor(s.base.now / 86400);
  s.base.store.memory.seed({
    pk: 'MCPMETA#u',
    sk: `WRITERATE#v1-checkin#${day}`,
    n: V1_LIMITS.lookups,
    lookups: V1_LIMITS.lookups,
    revision: 3,
    expires_at: (day + 2) * 86400
  });
  const r = await call(s, t.token, 'POST', '/v1/check-ins', report());
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(s.asked.length, 0);
  assert.equal(shown(r).label, 'Unnamed stop');
  assert.equal(shown(r).named_by, 'none');
  assert.equal(r.response.headers.get('ratelimit-remaining'), '0');
  s.base.store.memory.seed({
    pk: 'MCPMETA#u',
    sk: `WRITERATE#v1-checkin#${day}`,
    n: V1_LIMITS.checkin,
    lookups: V1_LIMITS.lookups,
    revision: 9,
    expires_at: (day + 2) * 86400
  });
  const stopped = await call(s, t.token, 'POST', '/v1/check-ins', report({ arrived: LEAVE }));
  assert.equal(failed(stopped).code, 'rate_limited');
});

test('a failed lookup never fails the write, and the log holds no spot', async () => {
  const s = setup(),
    t = await make(s);
  s.naming('fail');
  const r = await call(s, t.token, 'POST', '/v1/check-ins', report());
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(shown(r).label, 'Unnamed stop');
  assert.ok(s.logs.some((l) => l.event === 'check-in-name-error'));
  s.naming('none');
  const none = await call(s, t.token, 'POST', '/v1/check-ins', report({ arrived: LEAVE }));
  assert.equal(shown(none).named_by, 'none');
  await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Secret garden', ...HOME });
  const logged = JSON.stringify(s.logs);
  for (const word of ['44.97', '93.26', 'Secret garden']) assert.ok(!logged.includes(word), word);
  // Nor the audit rows.
  const audit = JSON.stringify(s.base.store.memory.all().filter((row) => String(row.sk).startsWith('LOG#')));
  for (const word of ['44.97', '93.26', 'Secret garden']) assert.ok(!audit.includes(word), word);
});

test('deleting every check-in needs ?confirm=all, leaves the names, and counts what went', async () => {
  const s = setup(),
    t = await make(s),
    at = Date.parse('2026-01-01T00:00:00Z');
  // More than a transaction holds, far apart so none merge.
  for (let i = 0; i < 95; i++) {
    const when = new Date(at + i * 86400_000).toISOString(),
      id = `c${at + i * 86400_000}-ab`;
    s.base.store.memory.seed({
      pk: 'USER#u',
      sk: checkInKey(when, id),
      id,
      at: when,
      arrived: when,
      left: null,
      ...HOME,
      source: 'visit',
      day: when.slice(0, 10),
      connection: t.id,
      revision: 1
    });
  }
  await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME });
  assert.equal(failed(await call(s, t.token, 'DELETE', '/v1/check-ins')).field, 'confirm');
  assert.equal(failed(await call(s, t.token, 'DELETE', '/v1/check-ins?confirm=yes')).field, 'confirm');
  assert.equal(checkIns(s).length, 95);
  const gone = await call(s, t.token, 'DELETE', '/v1/check-ins?confirm=all');
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal(gone.json.deleted, 95);
  assert.equal(checkIns(s).length, 0);
  assert.equal(((await call(s, t.token, 'GET', '/v1/check-ins/places')).json.places as unknown[]).length, 1);
  const log = (await call(s, t.token, 'GET', '/v1/activity?kinds=checkin')).json.items as OAuthRow[],
    row = log.filter((r) => r.kind === 'checkin.deleted');
  assert.equal(row.length, 1);
  assert.equal(row[0]!.count, 95);
  assert.equal(row[0]!.all, true);
});

test('a check-in touches no note count, and the export has them all', async () => {
  const s = setup(),
    t = await make(s);
  await call(s, t.token, 'POST', '/v1/check-ins', report({ left: LEAVE }));
  await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME });
  const me = await call(s, t.token, 'GET', '/v1/me');
  assert.equal(me.status, 200);
  assert.equal(s.rows().filter((r) => String(r.sk).startsWith('NOTE#')).length, 0);
  const exported = build(await s.base.store.exportItems('u'), '2026-10-13T12:00:00.000Z');
  assert.equal(exported.check_ins?.length, 1);
  assert.equal(exported.check_ins?.[0]!.lat, HOME.lat);
  assert.equal(exported.check_ins?.[0]!.left, '2026-10-12T15:00:00.000Z');
  assert.ok(!('pk' in exported.check_ins![0]!));
  assert.equal(exported.named_places?.[0]!.name, 'Home');
  const words = markdown(exported);
  assert.match(words, /## Check-ins/);
  assert.match(words, /## Remembered places/);
});

test('another token never fills in or reads a stop it did not send, and its report is its own', async () => {
  const s = setup(),
    first = await make(s, ['notes:write'], 'Old phone'),
    second = await make(s, ['notes:write'], 'New phone');
  const sent = await call(s, first.token, 'POST', '/v1/check-ins', report());
  assert.equal(sent.status, 201);
  const other = await call(s, second.token, 'POST', '/v1/check-ins', report({ left: '2026-10-12T15:00:00Z' }));
  assert.equal(other.status, 201, JSON.stringify(other.json));
  assert.notEqual(shown(other).id, shown(sent).id);
  assert.equal(checkIns(s).length, 2);
  assert.equal(checkIns(s).find((c) => c.id === shown(sent).id)!.left, null);
  // Each goes on filling in its own.
  const again = await call(s, second.token, 'POST', '/v1/check-ins', report({ left: '2026-10-12T15:10:00Z' }));
  assert.equal(again.status, 200);
  assert.equal(shown(again).id, shown(other).id);
  // They read as the one stay.
  const all = await make(s),
    items = (await call(s, all.token, 'GET', '/v1/check-ins')).json.items as OAuthRow[];
  assert.equal(items.length, 1);
  assert.equal((items[0]!.ids as string[]).length, 2);
  assert.equal(items[0]!.left, '2026-10-12T15:10:00.000Z');
});

test('with notes:all a report fills in another token’s stop, and the write proves that scope', async () => {
  const s = setup(),
    first = await make(s, ['notes:write'], 'Old phone'),
    all = await make(s),
    sent = await call(s, first.token, 'POST', '/v1/check-ins', report()),
    filled = await call(s, all.token, 'POST', '/v1/check-ins', report({ left: '2026-10-12T15:00:00Z' }));
  assert.equal(filled.status, 200, JSON.stringify(filled.json));
  assert.equal(shown(filled).id, shown(sent).id);
  assert.equal(checkIns(s).length, 1);
  // Lose the scope and the same report no longer reaches it.
  const narrowed = await make(s, ['notes:write'], 'Narrow');
  const own = await call(s, narrowed.token, 'POST', '/v1/check-ins', report({ left: '2026-10-12T15:20:00Z' }));
  assert.equal(own.status, 201);
  assert.equal(checkIns(s).find((c) => c.id === shown(sent).id)!.left, '2026-10-12T15:00:00.000Z');
});

test('only a token that reads the log or all your notes is told a remembered name', async () => {
  const s = setup(),
    all = await make(s),
    writer = await make(s, ['notes:write'], 'Writer'),
    reader = await make(s, ['notes:write', 'activity'], 'Reader');
  await call(s, all.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME });
  const blind = await call(s, writer.token, 'POST', '/v1/check-ins', report());
  assert.equal(shown(blind).label, 'Uptown, Springfield');
  assert.equal(shown(blind).place, null);
  const told = await call(s, reader.token, 'POST', '/v1/check-ins', report({ arrived: '2026-10-12T16:00:00Z' }));
  assert.equal(shown(told).label, 'Home');
  // Taking its own name away tells the writer no more.
  const named = await call(s, writer.token, 'PATCH', `/v1/check-ins/${String(shown(blind).id)}`, {
    name: 'Lunch',
    revision: shown(blind).revision
  });
  assert.equal(shown(named).label, 'Lunch');
  const cleared = await call(s, writer.token, 'PATCH', `/v1/check-ins/${String(shown(named).id)}`, {
    name: null,
    revision: shown(named).revision
  });
  assert.equal(shown(cleared).label, 'Uptown, Springfield');
});

test('a stay across two spots of one remembered place stays one when named', async () => {
  const s = setup(),
    t = await make(s),
    far = { lat: HOME.lat + 0.01, lon: HOME.lon };
  await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Campus', ...HOME });
  await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Campus', ...far });
  await call(
    s,
    t.token,
    'POST',
    '/v1/check-ins',
    report({ arrived: '2026-10-12T14:00:00Z', left: '2026-10-12T15:00:00Z' })
  );
  await call(
    s,
    t.token,
    'POST',
    '/v1/check-ins',
    report({ arrived: '2026-10-12T15:05:00Z', left: '2026-10-12T16:00:00Z', ...far })
  );
  const stay = ((await call(s, t.token, 'GET', '/v1/check-ins')).json.items as OAuthRow[])[0]!;
  assert.equal((stay.ids as string[]).length, 2);
  const named = await call(s, t.token, 'PATCH', `/v1/check-ins/${String(stay.id)}`, {
    name: 'Reunion',
    revision: stay.revision
  });
  assert.equal(named.status, 200, JSON.stringify(named.json));
  const items = (await call(s, t.token, 'GET', '/v1/check-ins')).json.items as OAuthRow[];
  assert.equal(items.length, 1);
  assert.equal(items[0]!.label, 'Reunion');
  assert.equal((await call(s, t.token, 'DELETE', `/v1/check-ins/${String(stay.id)}`)).status, 204);
  assert.equal(checkIns(s).length, 0);
});

test('a stay too long for one transaction refuses a name and changes nothing, and still deletes', async () => {
  const s = setup(),
    t = await make(s),
    start = Date.parse('2026-10-01T00:00:00Z');
  for (let i = 0; i <= STAY_WRITE_MAX; i++) {
    const at = new Date(start + i * 600_000).toISOString(),
      id = `c${Date.parse(at)}-a${i.toString(16)}`;
    s.base.store.memory.seed({
      pk: 'USER#u',
      sk: `CHECKIN#${at}#${id}`,
      id,
      at,
      arrived: at,
      left: null,
      ...HOME,
      source: 'visit',
      day: at.slice(0, 10),
      name: null,
      connection: t.id,
      revision: 1
    });
  }
  const stay = ((await call(s, t.token, 'GET', '/v1/check-ins')).json.items as OAuthRow[])[0]!;
  assert.equal((stay.ids as string[]).length, STAY_WRITE_MAX + 1);
  const refused = await call(s, t.token, 'PATCH', `/v1/check-ins/${String(stay.id)}`, {
    name: 'Long',
    revision: stay.revision
  });
  assert.equal(refused.status, 400);
  assert.equal(failed(refused).code, 'invalid_request');
  assert.ok(checkIns(s).every((c) => c.name === null && c.revision === 1));
  assert.equal((await call(s, t.token, 'DELETE', `/v1/check-ins/${String(stay.id)}`)).status, 204);
  assert.equal(checkIns(s).length, 0);
});

// Ignore this location (Jamie, 2026-11-08): no new stop is kept at an ignored
// place, those kept already are hidden and come back when it is unignored, and
// the ones there can be deleted for the count the owner was shown.
const placeOf = (r: { json: OAuthRow }) => r.json.place as OAuthRow;
const kinds = async (s: Setup, token: string) =>
  ((await call(s, token, 'GET', '/v1/activity?kinds=checkin')).json.items as OAuthRow[]).map((r) => r.kind);

test('no new stop is kept at an ignored place, no lookup is paid for, and the answer says so', async () => {
  const s = setup(),
    t = await make(s),
    made = await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME, ignored: true });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(placeOf(made).ignored, true);
  assert.deepEqual((await kinds(s, t.token)).sort(), ['checkin.ignored', 'checkin.place']);
  const skipped = await call(s, t.token, 'POST', '/v1/check-ins', report({ ...NEAR }), 'ignored-1');
  assert.equal(skipped.status, 200, JSON.stringify(skipped.json));
  assert.equal(skipped.json.kept, false);
  assert.equal(shown(skipped).arrived, '2026-10-12T14:00:00.000Z');
  assert.equal(checkIns(s).length, 0);
  assert.equal(s.asked.length, 0);
  // Sent again it answers the same, and still keeps nothing.
  const again = await call(s, t.token, 'POST', '/v1/check-ins', report({ ...NEAR }), 'ignored-1');
  assert.deepEqual(again.json, skipped.json);
  assert.equal((await call(s, t.token, 'POST', '/v1/check-ins', report({ ...NEAR, left: LEAVE }))).json.kept, false);
  assert.equal(checkIns(s).length, 0);
  // Anywhere else is kept as ever.
  const shop = await call(s, t.token, 'POST', '/v1/check-ins', report({ ...SHOP }));
  assert.equal(shop.status, 201);
  assert.equal(shop.json.kept, true);
  assert.equal(checkIns(s).length, 1);
  // A place joined by name keeps its flag, and a new one starts unignored.
  const joined = await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'home', lat: 1, lon: 1 });
  assert.equal(placeOf(joined).ignored, true);
  const work = await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Work', lat: 2, lon: 2 });
  assert.equal(placeOf(work).ignored, false);
  assert.equal(
    failed(await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'X', ...SHOP, ignored: 'yes' })).field,
    'ignored'
  );
});

test('the stops kept before are hidden while it is ignored, and come back unignored', async () => {
  const s = setup(),
    t = await make(s),
    first = await call(s, t.token, 'POST', '/v1/check-ins', report());
  await call(s, t.token, 'POST', '/v1/check-ins', report({ ...SHOP, arrived: '2026-10-12T18:00:00Z' }));
  const place = placeOf(await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME })),
    path = `/v1/check-ins/places/${String(place.id)}`,
    id = String(shown(first).id),
    list = async () => ((await call(s, t.token, 'GET', '/v1/check-ins')).json.items as OAuthRow[]).map((c) => c.label);
  assert.equal(failed(await call(s, t.token, 'PATCH', path, {})).field, 'name');
  assert.equal(failed(await call(s, t.token, 'PATCH', path, { ignored: 1 })).field, 'ignored');
  const ignored = await call(s, t.token, 'PATCH', path, { ignored: true });
  assert.equal(ignored.status, 200, JSON.stringify(ignored.json));
  assert.equal(placeOf(ignored).ignored, true);
  assert.equal(placeOf(ignored).name, 'Home');
  assert.deepEqual(await list(), ['Uptown, Springfield']);
  assert.equal(
    failed(await call(s, t.token, 'PATCH', `/v1/check-ins/${id}`, { name: 'A', revision: 1 })).code,
    'not_found'
  );
  assert.equal(failed(await call(s, t.token, 'DELETE', `/v1/check-ins/${id}`)).code, 'not_found');
  // A report filling in the stop kept before still lands, hidden.
  const late = await call(s, t.token, 'POST', '/v1/check-ins', report({ left: LEAVE }));
  assert.equal(late.status, 200, JSON.stringify(late.json));
  assert.equal(late.json.kept, true);
  assert.equal(checkIns(s).find((c) => c.id === id)!.left, '2026-10-12T15:00:00.000Z');
  // The log hides its row, and nothing is deleted.
  const log = await kinds(s, t.token);
  assert.equal(log.filter((k) => k === 'checkin').length, 1);
  assert.ok(log.includes('checkin.ignored'));
  assert.equal(checkIns(s).length, 2);
  // Renaming keeps it ignored; unignoring brings the stop back.
  assert.equal(placeOf(await call(s, t.token, 'PATCH', path, { name: 'Our home' })).ignored, true);
  const back = await call(s, t.token, 'PATCH', path, { ignored: false, name: 'Home' });
  assert.equal(placeOf(back).ignored, false);
  assert.deepEqual(await list(), ['Uptown, Springfield', 'Home']);
  const after = await kinds(s, t.token);
  assert.equal(after.filter((k) => k === 'checkin').length, 2);
  assert.ok(after.includes('checkin.unignored'));
  assert.ok(!('ignored' in s.rows().find((r) => r.sk === `NAMEDPLACE#${String(place.id)}`)!));
});

test('the check-ins at a place are counted, hidden or not, and deleted for that count', async () => {
  const s = setup(),
    t = await make(s);
  await call(s, t.token, 'POST', '/v1/check-ins', report({ left: LEAVE }));
  await call(s, t.token, 'POST', '/v1/check-ins', report({ ...NEAR, arrived: '2026-10-12T18:00:00Z' }));
  await call(s, t.token, 'POST', '/v1/check-ins', report({ ...SHOP, arrived: '2026-10-12T21:00:00Z' }));
  const place = placeOf(await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME })),
    path = `/v1/check-ins/places/${String(place.id)}`;
  await call(s, t.token, 'PATCH', path, { ignored: true });
  const counted = await call(s, t.token, 'GET', path);
  assert.equal(counted.status, 200, JSON.stringify(counted.json));
  assert.equal(placeOf(counted).check_ins, 2);
  assert.equal(placeOf(counted).ignored, true);
  assert.equal(failed(await call(s, t.token, 'GET', '/v1/check-ins/places/p-0')).code, 'not_found');
  for (const query of ['', '?count=', '?count=two', '?count=-1', '?count=01'])
    assert.equal(failed(await call(s, t.token, 'DELETE', `${path}/check-ins${query}`)).field, 'count', query);
  const stale = await call(s, t.token, 'DELETE', `${path}/check-ins?count=1`);
  assert.equal(failed(stale).code, 'revision_mismatch');
  assert.equal(failed(stale).count, 2);
  assert.equal(checkIns(s).length, 3);
  const gone = await call(s, t.token, 'DELETE', `${path}/check-ins?count=2`, undefined, 'here-1');
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal(gone.json.deleted, 2);
  assert.deepEqual(
    checkIns(s).map((c) => c.lat),
    [SHOP.lat]
  );
  // The place stays, still ignored; the key answers its first result.
  assert.equal(placeOf(await call(s, t.token, 'GET', path)).check_ins, 0);
  assert.equal(placeOf(await call(s, t.token, 'GET', path)).ignored, true);
  assert.deepEqual(
    (await call(s, t.token, 'DELETE', `${path}/check-ins?count=2`, undefined, 'here-1')).json,
    gone.json
  );
  const rows = (await call(s, t.token, 'GET', '/v1/activity?kinds=checkin')).json.items as OAuthRow[],
    deleted = rows.filter((r) => r.kind === 'checkin.deleted');
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]!.place, place.id);
  assert.equal(deleted[0]!.count, 2);
  // Nothing there deletes nothing and adds no row.
  assert.equal((await call(s, t.token, 'DELETE', `${path}/check-ins?count=0`)).json.deleted, 0);
  assert.equal((await kinds(s, t.token)).filter((k) => k === 'checkin.deleted').length, 1);
  assert.equal(
    failed(await call(s, t.token, 'DELETE', '/v1/check-ins/places/p-0/check-ins?count=0')).code,
    'not_found'
  );
});

test('an Add notes token is not told the tags a stop took from a remembered place, only those it set (AUTHZ-2)', async () => {
  const s = setup(),
    owner = await make(s),
    writer = await make(s, ['notes:write'], 'Writer'),
    reader = await make(s, ['notes:write', 'activity'], 'Reader');
  const made = await call(s, owner.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME, tags: ['family'] });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const first = await call(s, writer.token, 'POST', '/v1/check-ins', report(), 'authz2'),
    again = await call(s, writer.token, 'POST', '/v1/check-ins', report(), 'authz2');
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.deepEqual([shown(first).tags, shown(first).tag_names, shown(first).label], [[], [], 'Uptown, Springfield']);
  assert.deepEqual(again.json, first.json);
  // The stop still took them; a token that reads the log sees them.
  assert.deepEqual(checkIns(s)[0]!.tags, ['family']);
  const seen = await call(s, reader.token, 'POST', '/v1/check-ins', report({ arrived: '2026-10-13T14:00:00Z' }));
  assert.deepEqual([shown(seen).tags, shown(seen).label], [['family'], 'Home']);
  // Naming its stop shows none still; tags it sends are the stop's own.
  const id = String(shown(first).id),
    named = await call(s, writer.token, 'PATCH', `/v1/check-ins/${id}`, { name: 'Lunch', revision: 1 });
  assert.equal(named.status, 200, JSON.stringify(named.json));
  assert.deepEqual([shown(named).tags, shown(named).tag_names], [[], []]);
  const tagged = await call(s, writer.token, 'PATCH', `/v1/check-ins/${id}`, { tags: ['work'], revision: 2 });
  assert.deepEqual(shown(tagged).tags, ['work']);
});

test('a check-in receipt keeps no spot or time its request sent, and a replay puts them back (AUTHZ-3)', async () => {
  const s = setup(),
    t = await make(s),
    receipt = (key: string) => {
      const row = s.base.store.memory.all().find((r) => r.sk === apiReceiptKey(key))!;
      return JSON.parse(String(row.result)) as { body: { check_in: OAuthRow }; refilled?: string[] };
    },
    again = async (body: OAuthRow, key: string, first: Awaited<ReturnType<typeof call>>) => {
      const replay = await call(s, t.token, 'POST', '/v1/check-ins', body, key);
      assert.equal(replay.response.headers.get('idempotent-replayed'), 'true', key);
      assert.deepEqual([replay.status, replay.json], [first.status, first.json], key);
    };
  await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME, ignored: true });
  // A stop at an ignored place: nothing kept, and its receipt has no spot or time.
  const home = report({ left: LEAVE }),
    ignored = await call(s, t.token, 'POST', '/v1/check-ins', home, 'home');
  assert.deepEqual([ignored.status, ignored.json.kept, shown(ignored).lat], [200, false, HOME.lat]);
  const kept = receipt('home');
  assert.deepEqual(kept.refilled, ['lat', 'lon', 'accuracy_m', 'arrived', 'left', 'at']);
  for (const field of kept.refilled!) assert.equal(kept.body.check_in[field], null, field);
  assert.equal(kept.body.check_in.day, '2026-10-12');
  await again(home, 'home', ignored);
  // A stop deleted since: the replay answers as before, from the request.
  const shop = report({ ...SHOP, left: LEAVE }),
    made = await call(s, t.token, 'POST', '/v1/check-ins', shop, 'shop');
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal((await call(s, t.token, 'DELETE', `/v1/check-ins/${String(shown(made).id)}`)).status, 204);
  assert.ok(!JSON.stringify(receipt('shop')).includes(String(SHOP.lon)));
  await again(shop, 'shop', made);
  // A report that goes on with a stop shows the stop's own spot, which stays.
  const open = await call(s, t.token, 'POST', '/v1/check-ins', report({ ...SHOP, arrived: '2026-10-13T14:00:00Z' })),
    moved = report({ ...SHOP, lat: SHOP.lat + 0.0001, arrived: '2026-10-13T14:00:00Z', left: '2026-10-13T15:00:00Z' }),
    closed = await call(s, t.token, 'POST', '/v1/check-ins', moved, 'moved');
  assert.deepEqual([closed.status, shown(closed).id, shown(closed).lat], [200, shown(open).id, SHOP.lat]);
  assert.deepEqual(receipt('moved').refilled, ['lon', 'accuracy_m', 'arrived', 'left', 'at']);
  assert.equal(receipt('moved').body.check_in.lat, SHOP.lat);
  await again(moved, 'moved', closed);
});

test('tags that would take a place or its stays past 20 are refused, never cut (1.22.2)', async () => {
  const s = setup(),
    t = await make(s),
    twenty = Array.from({ length: 20 }, (_, i) => `tag ${i}`);
  const made = await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME, tags: twenty });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const place = made.json.place as OAuthRow,
    tagsNow = async () =>
      ((await call(s, t.token, 'GET', `/v1/check-ins/places/${String(place.id)}`)).json.place as OAuthRow).tags;
  // The same name again joins its tags to the place's: a 21st is refused.
  const more = await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'home', ...NEAR, tags: ['Dock'] });
  assert.deepEqual([more.status, failed(more).code, failed(more).field], [400, 'invalid_request', 'tags']);
  assert.equal(((await tagsNow()) as string[]).length, 20);
  assert.equal(
    (await call(s, t.token, 'POST', '/v1/check-ins/places', { name: 'Home', ...HOME, tags: ['TAG 0'] })).status,
    200
  );
  // A stop there takes the place's twenty; tagging the stays there with a new one is refused too.
  assert.equal((await call(s, t.token, 'POST', '/v1/check-ins', report())).status, 201);
  const path = `/v1/check-ins/places/${String(place.id)}/check-ins`,
    refused = await call(s, t.token, 'PATCH', path, { tags: ['Dock'], count: 1 });
  assert.deepEqual([refused.status, failed(refused).code, failed(refused).field], [400, 'invalid_request', 'tags']);
  assert.equal((checkIns(s)[0]!.tags as string[]).length, 20);
  assert.deepEqual((await call(s, t.token, 'PATCH', path, { tags: ['Tag 1'], count: 1 })).json, { tagged: 0 });
});
