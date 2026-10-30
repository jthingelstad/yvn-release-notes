/** Upcoming through `/v1` (docs/API.md, Phase 4): the list with past
 * one-time dates left out, saves all or nothing from the revision read,
 * dry runs that write nothing, removal, the daily count, the activity rows
 * and the reminders each morning carries. Fictional account only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpApp, type McpOptions } from '../../server/mcp/app.ts';
import { REMINDER_DAYS_MAX } from '../../server/mcp/v1.ts';
import { captureNote } from '../../workers/capture.ts';
import { Tokens, V1_LIMITS, V1_UPCOMING_MAX } from '../../packages/backend/tokens.ts';
import type { City } from '../../packages/backend/places.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { fixture, ORIGIN, NOW } from '../oauth/fixtures.ts';

const TODAY = '2026-10-13',
  PARIS: City[] = [
    { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 },
    { name: 'Paris', region: 'Texas', country: 'United States', tz: 'America/Chicago', lat: 33.66, lon: -95.56 }
  ];

function setup() {
  const asked: string[] = [],
    ctx = {
      ...fixture(),
      geocode: async (q: string) => {
        asked.push(q);
        if (q === 'down') throw new Error('Search down');
        return q.toLowerCase() === 'paris' ? PARIS : [];
      }
    },
    options: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: () => {} }),
      log: () => {}
    };
  return { ctx, asked, app: createMcpApp(options) };
}
type Ctx = ReturnType<typeof setup>['ctx'];
async function make(ctx: Ctx, scopes = ['upcoming'], name = 'Changelog') {
  return (await new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now }).make('u', {
    name,
    scopes,
    expiry: 'never'
  })) as OAuthRow & { token: string; id: string };
}
async function call(
  app: ReturnType<typeof createMcpApp>,
  method: string,
  path: string,
  o: { token: string; body?: unknown; headers?: Record<string, string> }
) {
  const headers: Record<string, string> = {
    authorization: 'Bearer ' + o.token,
    ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...o.headers
  };
  const response = await app.request(ORIGIN + path, {
      method,
      headers,
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) })
    }),
    text = await response.text();
  let json: OAuthRow | null = null;
  try {
    json = text ? (JSON.parse(text) as OAuthRow) : null;
  } catch {
    /* A text/plain answer. */
  }
  return { response, status: response.status, text, json, error: (json?.error ?? {}) as OAuthRow };
}
const entries = (ctx: Ctx) =>
  ctx.store.memory.all().filter((r) => r.pk === 'USER#u' && String(r.sk).startsWith('UPCOMING#'));
const MOM = { kind: 'birthday', title: 'Mom', date: '11-04', year: 1955 },
  TRIP = { kind: 'trip', title: 'Visit', date: '2026-12-20', end_date: '2026-12-27', place: 'Paris, Texas' };

test('save adds dates all or nothing, answers them in order with ids, and logs each via the token', async () => {
  const { ctx, app, asked } = setup(),
    t = await make(ctx);
  // One bad entry and nothing is saved; the error names it.
  const bad = await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { add: [MOM, { ...TRIP, kind: 'cruise' }] }
  });
  assert.equal(bad.status, 400, bad.text);
  assert.deepEqual(
    [bad.error.code, bad.error.field, bad.error.message],
    ['invalid_request', 'add[1]', 'kind is birthday, anniversary, trip or event. (add[1])']
  );
  assert.equal(entries(ctx).length, 0);

  const saved = await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { add: [MOM, TRIP] },
    headers: { 'idempotency-key': 'u-1', 'user-agent': 'Changelog/0.3 (iOS 26.1)' }
  });
  assert.equal(saved.status, 200, saved.text);
  const body = saved.json!,
    added = body.added as OAuthRow[];
  assert.equal(body.dry_run, false);
  assert.deepEqual(
    added.map((e) => [e.title, e.kind, e.revision, e.next, e.place]),
    [
      ['Mom', 'birthday', 1, '2026-11-04', null],
      ['Visit', 'trip', 1, '2026-12-20', 'Paris, Texas, United States']
    ]
  );
  assert.match(String(added[0]!.line), /^Mom turns /);
  assert.deepEqual([body.changed, body.removed], [[], []]);
  // The first date added is the Roadmap's first tier.
  assert.ok((body.unlocked as OAuthRow[]).length >= 1);
  assert.ok(asked.includes('Paris'));
  assert.equal(saved.response.headers.get('ratelimit-limit'), String(V1_LIMITS.upcoming));
  assert.equal(saved.response.headers.get('ratelimit-remaining'), String(V1_LIMITS.upcoming - 1));
  assert.equal(entries(ctx).length, 2);
  const rows = ctx.store.memory.all().filter((r) => r.kind === 'upcoming.added');
  assert.deepEqual(
    rows.map((r) => [r.via, r.token, r.client, r.upcoming]).sort(),
    added.map((e) => ['token', 'Changelog', 'Changelog', e.id]).sort()
  );
  // The row never holds a title.
  assert.ok(!JSON.stringify(rows).includes('Mom'));
  const badge = ctx.store.memory.all().find((r) => r.kind === 'badge.earned');
  assert.deepEqual([badge?.via, badge?.token], ['token', 'Changelog']);

  // A retry with the same key answers the same and adds nothing.
  const again = await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { add: [MOM, TRIP] },
    headers: { 'idempotency-key': 'u-1' }
  });
  assert.equal(again.response.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(
    (again.json!.added as OAuthRow[]).map((e) => e.id),
    added.map((e) => e.id)
  );
  assert.equal(entries(ctx).length, 2);
  const other = await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { add: [MOM] },
    headers: { 'idempotency-key': 'u-1' }
  });
  assert.equal(other.error.code, 'idempotency_mismatch');
});

test('a dry run checks and finds cities but writes nothing, and counts as a read', async () => {
  const { ctx, app } = setup(),
    t = await make(ctx),
    before = new Map(ctx.store.memory.all().map((r) => [`${r.pk} ${r.sk}`, JSON.stringify(r)]));
  const dry = await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { add: [TRIP], dry_run: true },
    headers: { accept: 'text/plain' }
  });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.text, 'Checked, nothing saved: 1 added, 0 changed, 0 removed.\n');
  assert.equal(entries(ctx).length, 0);
  // Every row added or changed, not just new ones.
  const written = ctx.store.memory.all().filter((r) => before.get(`${r.pk} ${r.sk}`) !== JSON.stringify(r));
  // Only the token's read count and its reads row: no receipt, no write count.
  assert.ok(
    written.every((r) => String(r.pk).startsWith('MCPMETA#')),
    JSON.stringify(written.map((r) => r.sk))
  );
  assert.ok(written.some((r) => String(r.sk).startsWith(`TOKENREADS#${t.id}#`)));
  assert.ok(!written.some((r) => String(r.sk).startsWith('WRITERATE#')));
  const down = await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { add: [{ ...TRIP, place: 'down' }], dry_run: true }
  });
  assert.equal(down.error.code, 'unavailable');
  const nowhere = await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { add: [{ ...TRIP, place: 'Atlantis' }], dry_run: true }
  });
  assert.deepEqual([nowhere.error.code, nowhere.error.field], ['invalid_request', 'add[0]']);
  const flag = await call(app, 'POST', '/v1/upcoming/batch', { token: t.token, body: { add: [TRIP], dry_run: 'yes' } });
  assert.deepEqual([flag.error.code, flag.error.field], ['invalid_request', 'dry_run']);
});

test('changes and removals go from the revision read; one changed since is refused', async () => {
  const { ctx, app } = setup(),
    t = await make(ctx),
    first = (await call(app, 'POST', '/v1/upcoming/batch', { token: t.token, body: { add: [MOM, TRIP] } })).json!
      .added as OAuthRow[],
    [mom, trip] = first as [OAuthRow, OAuthRow];
  const stale = await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { change: [{ ...MOM, id: mom.id, revision: 7, title: 'Mum' }] }
  });
  assert.equal(stale.status, 409);
  assert.deepEqual([stale.error.code, stale.error.field], ['revision_mismatch', 'change[0]']);
  const missing = await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { remove: [{ id: 'nope', revision: 1 }] }
  });
  assert.deepEqual([missing.status, missing.error.code, missing.error.field], [404, 'not_found', 'remove[0]']);
  const both = await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { change: [{ ...MOM, id: mom.id, revision: 1, title: 'Mum' }], remove: [{ id: trip.id, revision: 1 }] }
  });
  assert.equal(both.status, 200, both.text);
  assert.deepEqual(
    (both.json!.changed as OAuthRow[]).map((e) => [e.id, e.title, e.revision]),
    [[mom.id, 'Mum', 2]]
  );
  assert.deepEqual(both.json!.removed, [trip.id]);
  assert.deepEqual(
    entries(ctx).map((r) => r.title),
    ['Mum']
  );
  const kinds = ctx.store.memory
    .all()
    .filter((r) => String(r.kind).startsWith('upcoming.'))
    .map((r) => r.kind)
    .sort();
  assert.deepEqual(kinds, ['upcoming.added', 'upcoming.added', 'upcoming.changed', 'upcoming.removed']);

  // DELETE takes the revision in the address.
  const path = `/v1/upcoming/${String(mom.id)}`;
  assert.equal((await call(app, 'DELETE', path, { token: t.token })).error.field, 'revision');
  // Its refusals name what it sent, never a list it didn't.
  const staleOne = await call(app, 'DELETE', path + '?revision=1', { token: t.token });
  assert.deepEqual([staleOne.error.code, staleOne.error.field], ['revision_mismatch', 'revision']);
  assert.ok(!String(staleOne.error.message).includes('remove['), String(staleOne.error.message));
  const nope = await call(app, 'DELETE', '/v1/upcoming/nope?revision=1', { token: t.token });
  assert.equal(nope.status, 404);
  assert.ok(!Object.hasOwn(nope.error, 'field'), JSON.stringify(nope.error));
  assert.ok(!String(nope.error.message).includes('remove['), String(nope.error.message));
  const gone = await call(app, 'DELETE', path + '?revision=2', {
    token: t.token,
    headers: { 'idempotency-key': 'd-1' }
  });
  assert.equal(gone.status, 204, gone.text);
  assert.equal(entries(ctx).length, 0);
  assert.equal(
    (await call(app, 'DELETE', path + '?revision=2', { token: t.token, headers: { 'idempotency-key': 'd-1' } })).status,
    204
  );
});

test('the list leaves out one-time dates already over, and counts them', async () => {
  const { ctx, app } = setup(),
    t = await make(ctx);
  await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { add: [TRIP, MOM, { kind: 'event', title: 'Gone', date: '2026-09-01' }] }
  });
  const list = await call(app, 'GET', '/v1/upcoming', { token: t.token });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(
    (list.json!.entries as OAuthRow[]).map((e) => e.title),
    ['Mom', 'Visit']
  );
  assert.deepEqual([list.json!.today, list.json!.past_left_out, list.json!.max_entries], [TODAY, 1, 200]);
  const plain = await call(app, 'GET', '/v1/upcoming', { token: t.token, headers: { accept: 'text/plain' } });
  assert.match(plain.text, /^2026-11-04 Mom turns .*\n2026-12-20 Visit/);
});

test('the reminders each morning carries, with when its email is due, across the clocks changing', async () => {
  const { ctx, app } = setup(),
    t = await make(ctx);
  await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: {
      add: [MOM, { kind: 'birthday', title: 'Quiet', date: '10-20', email: false }, { ...TRIP, reminders: [0] }]
    }
  });
  const r = await call(app, 'GET', '/v1/upcoming/reminders?days=31', { token: t.token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json!.from, r.json!.through], [TODAY, '2026-11-12']);
  const days = r.json!.days as { date: string; send_at: string; reminders: OAuthRow[] }[];
  // Mom's 7, 1 and 0 days before; Quiet is out of the email, so out of here.
  assert.deepEqual(
    days.map((d) => [d.date, d.send_at, d.reminders.map((x) => x.when)]),
    [
      ['2026-10-28', '2026-10-28T06:00:00-05:00', ['In 7 days']],
      ['2026-11-03', '2026-11-03T06:00:00-06:00', ['Tomorrow']],
      ['2026-11-04', '2026-11-04T06:00:00-06:00', ['Today']]
    ]
  );
  assert.deepEqual(Object.keys(days[0]!.reminders[0]!).sort(), ['date', 'line', 'upcoming', 'when']);
  assert.equal(days[0]!.reminders[0]!.date, '2026-11-04');
  assert.match(String(days[0]!.reminders[0]!.line), /^Mom turns /);
  // Two weeks unless asked.
  const short = await call(app, 'GET', '/v1/upcoming/reminders', { token: t.token, headers: { accept: 'text/plain' } });
  assert.equal(short.text, 'No reminders through 2026-10-26.\n');
  for (const days of ['0', String(REMINDER_DAYS_MAX + 1), 'x'])
    assert.equal(
      (await call(app, 'GET', '/v1/upcoming/reminders?days=' + days, { token: t.token })).error.field,
      'days',
      days
    );
});

test('Upcoming needs its own scope, and its own daily count and size', async () => {
  const { ctx, app } = setup(),
    notes = await make(ctx, ['notes:write', 'activity'], 'Notes'),
    t = await make(ctx);
  for (const [method, path] of [
    ['GET', '/v1/upcoming'],
    ['GET', '/v1/upcoming/reminders'],
    ['POST', '/v1/upcoming/batch'],
    ['DELETE', '/v1/upcoming/x?revision=1']
  ] as const) {
    const r = await call(app, method, path, { token: notes.token, ...(method === 'POST' ? { body: {} } : {}) });
    assert.deepEqual([r.status, r.error.code], [403, 'scope_required'], path);
    assert.match(String(r.error.message), /Upcoming ticked/);
  }
  // And an Upcoming token adds no notes.
  assert.equal(
    (await call(app, 'POST', '/v1/notes', { token: t.token, body: { text: 'Hi' } })).error.code,
    'scope_required'
  );
  const none = await call(app, 'POST', '/v1/upcoming/batch', { token: t.token, body: { add: [] } });
  assert.deepEqual(
    [none.error.code, none.error.message],
    ['invalid_request', 'Send at least one date to add, change or remove.']
  );
  const many = await call(app, 'POST', '/v1/upcoming/batch', {
    token: t.token,
    body: { add: Array.from({ length: V1_UPCOMING_MAX + 1 }, (_, i) => ({ ...MOM, title: 'P' + i })) }
  });
  assert.equal(many.error.code, 'invalid_request');
  ctx.store.seed({
    pk: 'MCPMETA#u',
    sk: `WRITERATE#v1-upcoming#${Math.floor(NOW / 86400)}`,
    n: V1_LIMITS.upcoming,
    revision: 1
  });
  const full = await call(app, 'POST', '/v1/upcoming/batch', { token: t.token, body: { add: [MOM] } });
  assert.equal(full.status, 429);
  assert.ok(Number(full.response.headers.get('retry-after')) > 0);
  // Notes keep their own counts.
  assert.equal((await call(app, 'POST', '/v1/notes', { token: notes.token, body: { text: 'Hi' } })).status, 201);
});
