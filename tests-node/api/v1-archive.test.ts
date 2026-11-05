/** Reading the archive through `/v1` (API 1.15.0; docs/API.md, Expansion):
 * the `notes:read` scope on its own, and the requests made from every note.
 * Fictional account and fake bucket only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpApp, type McpOptions } from '../../server/mcp/app.ts';
import { NOTES_PAGE_BYTES, V1_ROUTES } from '../../server/mcp/v1.ts';
import { captureNote } from '../../workers/capture.ts';
import { Tokens } from '../../packages/backend/tokens.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { computeVersion, releaseName, sameDayBefore } from '../../packages/domain/version.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { fixture, note, ORIGIN, PROFILE } from '../oauth/fixtures.ts';

const TODAY = '2026-10-13',
  ARCHIVE = V1_ROUTES.filter((r) => r.scope === 'notes:read');

function setup() {
  const ctx = {
      ...fixture(),
      objects: new FakeObjects(),
      media: {
        download: async (_uid: string, key: string, _type: string, seconds: number) =>
          `https://files.example/${key}?signed=${seconds}`,
        bytes: async () => new Uint8Array()
      }
    },
    options: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: () => {} }),
      log: () => {}
    };
  return { ctx, app: createMcpApp(options) };
}
type Ctx = ReturnType<typeof setup>['ctx'];
const make = async (ctx: Ctx, scopes: string[], name = 'Reader') =>
  (await new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now }).make('u', {
    name,
    scopes,
    expiry: 'never'
  })) as OAuthRow & { token: string; id: string };
async function get(app: ReturnType<typeof createMcpApp>, path: string, token: string, accept?: string) {
  const r = await app.request(ORIGIN + path, {
      headers: { authorization: 'Bearer ' + token, ...(accept ? { accept } : {}) }
    }),
    text = await r.text();
  let json: OAuthRow | null = null;
  try {
    json = JSON.parse(text) as OAuthRow;
  } catch {
    // A text answer.
  }
  return { status: r.status, text, json, error: (json?.error ?? {}) as OAuthRow };
}
const pathOf = (route: (typeof V1_ROUTES)[number]) =>
  route.template.replace('{date}', TODAY).replace('{v}', releaseName(computeVersion(PROFILE.birthday, TODAY).age)) +
  (route.name === 'search' ? '?q=lake' : '');

test('notes:read stands alone: it reads the whole archive and writes nothing', async () => {
  const { ctx, app } = setup(),
    reader = await make(ctx, ['notes:read']);
  note(ctx, 'w-lake', 'The lake', TODAY, { source: 'web' });
  note(ctx, 'e-mail', 'By email', TODAY, { source: 'email' });
  const listed = await get(app, `/v1/notes?from=${TODAY}`, reader.token);
  assert.deepEqual(((listed.json!.items as OAuthRow[]).map((n) => n.id) as string[]).sort(), ['e-mail', 'w-lake']);
  assert.equal((await get(app, `/v1/notes/${TODAY}/w-lake`, reader.token)).status, 200);
  assert.deepEqual((await get(app, `/v1/notes?from=${TODAY}&mine=true`, reader.token)).json!.items, []);
  for (const route of ARCHIVE) assert.equal((await get(app, pathOf(route), reader.token)).status, 200, route.name);

  const posted = await app.request(ORIGIN + '/v1/notes', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + reader.token, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Not from a reader' })
  });
  assert.equal(posted.status, 403);
  for (const [method, path] of [
    ['PUT', `/v1/notes/${TODAY}/w-lake`],
    ['DELETE', `/v1/notes/${TODAY}/w-lake`],
    ['POST', `/v1/notes/${TODAY}/w-lake/append`],
    ['POST', '/v1/uploads'],
    ['PUT', '/v1/tags/pinned']
  ] as const) {
    const r = await app.request(ORIGIN + path, {
      method,
      headers: { authorization: 'Bearer ' + reader.token, 'content-type': 'application/json' },
      ...(method === 'DELETE' ? {} : { body: '{"text":"x"}' })
    });
    assert.equal(r.status, 403, path);
  }
  assert.equal(ctx.store.memory.read({ pk: 'USER#u', sk: `NOTE#${TODAY}#w-lake` })!.text, 'The lake');
});

test('the archive opens to notes:all too, and notes:write alone still reads only its own', async () => {
  const { ctx, app } = setup(),
    all = await make(ctx, ['notes:write', 'notes:all'], 'All'),
    own = await make(ctx, ['notes:write'], 'Own'),
    other = await make(ctx, ['activity'], 'Other');
  note(ctx, 'w-lake', 'The lake', TODAY, { source: 'web' });
  for (const route of ARCHIVE) {
    assert.equal((await get(app, pathOf(route), all.token)).status, 200, route.name);
    const refused = await get(app, pathOf(route), own.token);
    assert.equal(refused.status, 403, route.name);
    assert.equal(refused.error.code, 'scope_required', route.name);
    assert.ok(!refused.text.includes('The lake'), route.name);
  }
  assert.equal((await get(app, `/v1/notes/${TODAY}/w-lake`, own.token)).error.code, 'not_yours');
  assert.deepEqual((await get(app, `/v1/notes?from=${TODAY}`, own.token)).json!.items, []);
  const noRead = await get(app, `/v1/notes?from=${TODAY}`, other.token);
  assert.equal(noRead.error.code, 'scope_required');
  assert.match(String(noRead.error.message), /can't read your notes/);
});

test('a reading token opens neither /mcp nor a web route', async () => {
  const { ctx, app } = setup(),
    reader = await make(ctx, ['notes:read']),
    mcp = await app.request(ORIGIN + '/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + reader.token,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
  assert.equal(mcp.status, 401);
});

test('GET /v1/days is the timeline, newest first, a page at a time, with what each day says', async () => {
  const { ctx, app } = setup(),
    reader = await make(ctx, ['notes:read']);
  note(ctx, 'w-a', 'First', '2026-10-10', {
    source: 'web',
    media: [{ n: 1, kind: 'image', type: 'image/jpeg', size: 1, key: 'media/u/a.jpg' }]
  });
  note(ctx, 'w-b', 'Second', '2026-10-10', { source: 'web' });
  ctx.store.seed({ pk: 'USER#u', sk: 'DAY#2026-10-09', sent_at: 'x' });
  ctx.store.seed({
    pk: 'USER#u',
    sk: 'PLACE#2026-10-08',
    city: 'Duluth',
    region: 'Minnesota',
    country: 'United States',
    lat: 46.78,
    lon: -92.1
  });
  ctx.store.seed({ pk: 'USER#u', sk: 'WEATHER#2026-10-10', high_c: 20, low_c: 10, code: 1, city: 'Duluth' });
  const first = (await get(app, '/v1/days?limit=2', reader.token)).json!,
    days = first.days as OAuthRow[];
  assert.deepEqual(
    days.map((d) => d.date),
    [TODAY, '2026-10-10']
  );
  assert.deepEqual([days[0]!.notes_total, days[0]!.files, days[0]!.emailed], [0, 0, false]);
  assert.deepEqual([days[1]!.notes_total, days[1]!.files], [2, 1]);
  assert.equal(days[1]!.version, computeVersion(PROFILE.birthday, '2026-10-10').toString());
  assert.equal((days[1]!.weather as OAuthRow).high_c, 20);
  assert.equal(typeof (days[1]!.weather as OAuthRow).line, 'string');
  assert.equal(typeof first.weather_credit, 'string');
  assert.ok(!JSON.stringify(first).includes('First'));
  assert.equal(first.next, '2026-10-10');
  const second = (await get(app, `/v1/days?limit=2&before=${String(first.next)}`, reader.token)).json!,
    older = second.days as OAuthRow[];
  assert.deepEqual(
    older.map((d) => d.date),
    ['2026-10-09', '2026-10-08']
  );
  assert.equal(older[0]!.emailed, true);
  assert.equal((older[1]!.place as OAuthRow).city, 'Duluth');
  assert.deepEqual(older[1]!.around, { label: 'Duluth, Minnesota', from: 'day' });
  assert.equal(second.next, null);
  assert.equal((await get(app, '/v1/days?before=soon', reader.token)).error.field, 'before');
  assert.equal((await get(app, '/v1/days?limit=101', reader.token)).error.field, 'limit');
});

test('GET /v1/days/{date} is one day, its notes oldest first, stopping at about a megabyte', async () => {
  const { ctx, app } = setup(),
    reader = await make(ctx, ['notes:read']),
    long = 'w'.repeat(Math.floor(NOTES_PAGE_BYTES * 0.6));
  for (const i of [0, 1])
    note(ctx, `w-${i}`, 'Memo ' + i, TODAY, {
      source: 'web',
      written_at: `${TODAY}T0${i}:00:00Z`,
      media: [{ n: 1, kind: 'audio', type: 'audio/mp4', size: 1, key: 'media/u/a.m4a', transcript: long }]
    });
  ctx.store.seed({ pk: 'USER#u', sk: `WEATHER#${TODAY}`, high_c: 20, low_c: 10, code: 1 });
  const day = (await get(app, `/v1/days/${TODAY}`, reader.token)).json!;
  assert.equal(day.today, true);
  assert.equal(day.notes_total, 2);
  assert.deepEqual(
    (day.notes as OAuthRow[]).map((n) => n.id),
    ['w-0']
  );
  assert.equal(typeof day.weather_credit, 'string');
  const rest = (await get(app, `/v1/notes?from=${TODAY}&after=${String(day.next)}`, reader.token)).json!;
  assert.deepEqual(
    (rest.items as OAuthRow[]).map((n) => n.id),
    ['w-1']
  );
  assert.equal(rest.next, null);
  for (const [date, code] of [
    ['2030-01-01', 'date_out_of_range'],
    ['1950-01-01', 'date_out_of_range'],
    ['soon', 'invalid_request']
  ] as const)
    assert.equal((await get(app, `/v1/days/${date}`, reader.token)).error.code, code, date);
  const empty = (await get(app, '/v1/days/2026-01-02', reader.token)).json!;
  assert.deepEqual([empty.notes, empty.next, empty.notes_total, empty.today], [[], null, 0, false]);
});

test('GET /v1/search finds every word and a tag, newest first, as far as asked', async () => {
  const { ctx, app } = setup(),
    reader = await make(ctx, ['notes:read']);
  note(ctx, 'w-old', 'Old lake walk #Maine', '2026-01-10', { source: 'web', tags: ['maine'] });
  note(ctx, 'w-new', 'New lake swim', '2026-10-10', { source: 'web' });
  note(ctx, 'w-memo', 'A memo', '2026-10-11', {
    source: 'web',
    media: [{ n: 1, kind: 'audio', type: 'audio/mp4', size: 1, key: 'media/u/a.m4a', transcript: 'by the lake' }]
  });
  const ids = (r: OAuthRow) => (r.items as OAuthRow[]).map((n) => n.id);
  const lake = (await get(app, '/v1/search?q=lake', reader.token)).json!;
  assert.deepEqual(ids(lake), ['w-memo', 'w-new', 'w-old']);
  assert.equal(lake.total, 3);
  assert.deepEqual(ids((await get(app, '/v1/search?q=lake+swim', reader.token)).json!), ['w-new']);
  assert.deepEqual(ids((await get(app, '/v1/search?tag=maine', reader.token)).json!), ['w-old']);
  assert.deepEqual(ids((await get(app, '/v1/search?q=lake&tag=maine', reader.token)).json!), ['w-old']);
  assert.deepEqual(ids((await get(app, '/v1/search?q=lake&from=2026-10-01&to=2026-10-10', reader.token)).json!), [
    'w-new'
  ]);
  const one = (await get(app, '/v1/search?q=lake&limit=1', reader.token)).json!;
  assert.deepEqual(ids(one), ['w-memo']);
  const two = (await get(app, `/v1/search?q=lake&limit=2&after=${String(one.next)}`, reader.token)).json!;
  assert.deepEqual(ids(two), ['w-new', 'w-old']);
  assert.equal(two.next, null);
  assert.equal(two.total, 3);
  for (const [path, field] of [
    ['/v1/search', 'q'],
    ['/v1/search?q=a+b+c+d+e+f+g+h+i+j+k', 'q'],
    ['/v1/search?tag=%23%23', 'tag'],
    ['/v1/search?q=lake&from=soon', 'from'],
    ['/v1/search?q=lake&to=2030-01-01', 'to'],
    ['/v1/search?q=lake&from=2026-10-10&to=2026-10-01', 'to'],
    ['/v1/search?q=lake&after=nope', 'after'],
    ['/v1/search?q=lake&include=all', 'include']
  ] as const)
    assert.equal((await get(app, path, reader.token)).error.field, field, path);
});

test('GET /v1/on-this-day is the same day of each earlier release, a few notes each', async () => {
  const { ctx, app } = setup(),
    reader = await make(ctx, ['notes:read']),
    [last, before] = sameDayBefore(PROFILE.birthday, TODAY) as [string, string];
  for (const i of [0, 1, 2, 3, 4, 5, 6]) note(ctx, `w-${i}`, 'Words ' + i, last, { source: 'web' });
  note(ctx, 'w-old', 'Older', before, { source: 'web' });
  const answer = (await get(app, '/v1/on-this-day?limit=1', reader.token)).json!,
    days = answer.days as OAuthRow[];
  assert.equal(answer.date, TODAY);
  assert.deepEqual(
    days.map((d) => [d.date, d.notes_total, (d.notes as unknown[]).length]),
    [[last, 7, 5]]
  );
  assert.equal(answer.next, last);
  const rest = (await get(app, `/v1/on-this-day?before=${String(answer.next)}`, reader.token)).json!;
  assert.deepEqual(
    (rest.days as OAuthRow[]).map((d) => d.date),
    [before]
  );
  assert.equal(rest.next, null);
  assert.equal((await get(app, '/v1/on-this-day?date=2030-01-01', reader.token)).error.code, 'date_out_of_range');
});

test('releases, tags, pins, badges and the mail log read as the web and MCP do', async () => {
  const { ctx, app } = setup(),
    reader = await make(ctx, ['notes:read']),
    name = releaseName(computeVersion(PROFILE.birthday, TODAY).age);
  note(ctx, 'w-a', 'Lake #maine', '2026-10-10', {
    source: 'web',
    tags: ['maine'],
    place: { city: 'Duluth', region: 'Minnesota', country: 'United States', lat: 46.78, lon: -92.1 }
  });
  note(ctx, 'w-b', 'Hill #maine', '2026-10-11', { source: 'web', tags: ['maine'] });

  const releases = (await get(app, '/v1/releases', reader.token)).json!.releases as OAuthRow[];
  assert.equal(releases[0]!.v, name);
  assert.equal(releases[0]!.current, true);
  assert.equal(releases[0]!.notes, 2);
  const release = (await get(app, `/v1/releases/${name}`, reader.token)).json!.release as OAuthRow;
  assert.deepEqual(
    [release.v, release.days_with_notes, release.notes, release.first_note_day, release.tags],
    [name, 2, 2, '2026-10-10', [{ tag: 'maine', notes: 2 }]]
  );
  assert.equal((await get(app, '/v1/releases/99.0', reader.token)).error.code, 'not_found');
  assert.equal((await get(app, '/v1/releases/soon', reader.token)).error.code, 'not_found');

  assert.deepEqual((await get(app, '/v1/tags/all', reader.token)).json!.tags, [
    { tag: 'maine', notes: 2, days: 2, first: '2026-10-10', last: '2026-10-11' }
  ]);

  const map = (await get(app, '/v1/map/pins', reader.token)).json!,
    pins = map.pins as OAuthRow[];
  assert.equal(map.notes, 2);
  assert.deepEqual(
    pins.map((p) => [p.date, p.id, p.lat, p.place]),
    [['2026-10-10', 'w-a', 46.78, 'Duluth, Minnesota']]
  );
  assert.equal(map.next, null);
  assert.ok(!JSON.stringify(map).includes('media/u/'));
  assert.equal((await get(app, '/v1/map/pins?after=nope', reader.token)).error.field, 'after');

  const badges = (await get(app, '/v1/badges', reader.token)).json!;
  assert.equal(badges.show_badges, true);
  assert.ok(Array.isArray(badges.earned));
  ctx.store.memory.seed({ ...PROFILE, badges: false });
  assert.deepEqual(Object.keys((await get(app, '/v1/badges', reader.token)).json!).sort(), [
    'show_badges',
    'today',
    'version'
  ]);
  assert.deepEqual(
    Object.keys((await get(app, `/v1/releases/${name}`, reader.token)).json!.release as OAuthRow).includes('badges'),
    false
  );

  assert.deepEqual((await get(app, '/v1/mail-log', reader.token)).json!.entries, []);
});

test('a read asked for as text is a line for each thing', async () => {
  const { ctx, app } = setup(),
    reader = await make(ctx, ['notes:read']);
  note(ctx, 'w-a', 'The lake', TODAY, { source: 'web' });
  for (const route of ARCHIVE) {
    const r = await get(app, pathOf(route), reader.token, 'text/plain');
    assert.equal(r.status, 200, route.name);
    assert.ok(r.text.trim().length, route.name);
    assert.equal(r.json, null, route.name);
  }
  assert.match((await get(app, '/v1/search?q=lake', reader.token, 'text/plain')).text, /The lake/);
});

test('a token may be made with notes:read alone, and keeps its scopes in order', async () => {
  const { ctx } = setup(),
    alone = await make(ctx, ['notes:read'], 'Alone'),
    both = await make(ctx, ['notes:read', 'notes:write'], 'Both');
  assert.deepEqual(alone.scopes, ['notes:read']);
  assert.deepEqual(both.scopes, ['notes:write', 'notes:read']);
});
