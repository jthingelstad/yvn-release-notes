/** Writing as the web does (API 1.16.0): rich text on a new note, a note's
 * place and a day's own place set and removed through a token, and the day's
 * weather following, never failing the write. Fictional accounts only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpApp, type McpOptions } from '../../server/mcp/app.ts';
import { captureNote } from '../../workers/capture.ts';
import { Tokens } from '../../packages/backend/tokens.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import type { ApiStore } from '../../workers/api-writes.ts';
import { fixture, note, ORIGIN } from '../oauth/fixtures.ts';

const TODAY = '2026-10-13',
  EARLIER = '2026-10-10',
  PARIS = { name: 'Paris', region: 'Île-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 },
  OSLO = { name: 'Oslo', region: '', country: 'Norway', tz: 'Europe/Oslo', lat: 59.91, lon: 10.75 },
  SPOT = {
    from: 'device',
    name: 'Paris',
    district: 'Le Marais',
    country: 'France',
    tz: 'Europe/Paris',
    lat: 48.8566,
    lon: 2.3522
  };

function setup(sky: (url: string) => Promise<Record<string, unknown>> = fine) {
  const fetched: string[] = [],
    logged: OAuthRow[] = [],
    ctx = {
      ...fixture(),
      weatherFetch: (url: string) => {
        fetched.push(url);
        return sky(url);
      }
    },
    options: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: (f) => void logged.push(f) })
    };
  return { ctx, app: createMcpApp(options), fetched, logged };
}
async function fine(url: string) {
  const day = new URL(url).searchParams.get('start_date');
  return { daily: { time: [day], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [1] } };
}
type Set = ReturnType<typeof setup>;
const make = async ({ ctx }: Set, scopes: string[]) =>
  (await new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now }).make('u', {
    name: scopes.join(' '),
    scopes,
    expiry: 'never'
  })) as OAuthRow & { token: string };
async function call(
  { app }: Set,
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const response = await app.request(ORIGIN + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    text = await response.text(),
    plain = (response.headers.get('content-type') ?? '').startsWith('text/plain'),
    json = text && !plain ? (JSON.parse(text) as OAuthRow) : null;
  return { status: response.status, json, text, error: (json?.error ?? {}) as OAuthRow, headers: response.headers };
}
const created = (r: { json: OAuthRow | null }) => r.json!.note as OAuthRow,
  activity = async (s: Set, token: string) => {
    const rows = (await call(s, 'GET', '/v1/activity', token)).json!;
    return (rows.items ?? rows.activity ?? []) as OAuthRow[];
  };

test('a new note says it is rich; an edit keeps it, and plain stays plain', async () => {
  const s = setup(),
    { token } = await make(s, ['notes:write']);
  const rich = await call(s, 'POST', '/v1/notes', token, { text: '**Bold** day #house', markup: 'rich' });
  assert.equal(rich.status, 201, rich.text);
  const at = `/v1/notes/${String(created(rich).date)}/${String(created(rich).id)}`,
    read = (await call(s, 'GET', at, token)).json!;
  assert.equal(read.markup, 'rich');
  assert.deepEqual(read.tags, ['house']);
  const edit = await call(s, 'PUT', at, token, { text: '**Bolder** day', revision: read.revision });
  assert.equal(edit.status, 200, edit.text);
  assert.equal((await call(s, 'GET', at, token)).json!.markup, 'rich');

  for (const body of [{ text: 'Plain' }, { text: 'Plain, as a read says', markup: null }]) {
    const plain = await call(s, 'POST', '/v1/notes', token, body);
    assert.equal(plain.status, 201, plain.text);
    const read = await call(s, 'GET', `/v1/notes/${String(created(plain).date)}/${String(created(plain).id)}`, token);
    assert.equal(read.json!.markup, null);
  }

  const refused = await call(s, 'POST', '/v1/notes', token, { text: 'Hm', markup: 'html' });
  assert.equal(refused.status, 400);
  assert.equal(refused.error.code, 'invalid_request');
  assert.equal(refused.error.field, 'markup');
  // Only a new note takes it: an edit keeps what the note is.
  const notHere = await call(s, 'PUT', at, token, { text: 'x', revision: 'y', markup: 'rich' });
  assert.equal(notHere.error.field, 'markup');
});

test('a token sets, changes and removes the place of a note it wrote', async () => {
  const s = setup(),
    { token } = await make(s, ['notes:write', 'activity']),
    made = await call(s, 'POST', '/v1/notes', token, { text: 'Dinner' }),
    at = `/v1/notes/${String(created(made).date)}/${String(created(made).id)}`,
    { revision } = (await call(s, 'GET', at, token)).json!;

  const set = await call(s, 'PUT', at + '/place', token, { place: PARIS });
  assert.equal(set.status, 200, set.text);
  assert.equal(created(set).revision, revision, 'its answer is the revision it still has');
  let read = (await call(s, 'GET', at, token)).json!;
  assert.equal((read.place as OAuthRow).city, 'Paris');
  assert.equal(read.revision, revision);
  assert.equal(read.text, 'Dinner');
  assert.equal(read.edited_at, null);

  const spot = await call(s, 'PUT', at + '/place', token, { place: SPOT });
  assert.equal(spot.status, 200, spot.text);
  read = (await call(s, 'GET', at, token)).json!;
  assert.equal((read.place as OAuthRow).district, 'Le Marais');

  const cleared = await call(s, 'DELETE', at + '/place', token);
  assert.equal(cleared.status, 200, cleared.text);
  read = (await call(s, 'GET', at, token)).json!;
  assert.equal(read.place, null);
  assert.equal(read.no_place, true);
  assert.equal(read.revision, revision);

  // Setting one again takes the mark away. A row's key is its second, and a
  // badge lost with the place and earned again would match its first row.
  s.ctx.now += 1;
  await call(s, 'PUT', at + '/place', token, { place: PARIS });
  read = (await call(s, 'GET', at, token)).json!;
  assert.equal(read.no_place, false);

  const rows = (await activity(s, token)).filter((r) => r.kind === 'note.edited');
  assert.deepEqual(rows.map((r) => r.place).sort(), ['removed', 'set', 'set', 'set']);
  for (const row of rows) assert.equal(row.via, 'token');

  for (const place of [undefined, 'Paris', { name: 'Nowhere' }]) {
    const bad = await call(s, 'PUT', at + '/place', token, place === undefined ? {} : { place });
    assert.equal(bad.status, 400);
    assert.equal(bad.error.field, 'place');
  }
  const extra = await call(s, 'PUT', at + '/place', token, { place: PARIS, text: 'Sneaky' });
  assert.equal(extra.error.field, 'text');
});

test('another channel’s note takes a place only with notes:all', async () => {
  const s = setup(),
    { token } = await make(s, ['notes:write']),
    all = (await make(s, ['notes:write', 'notes:all'])).token,
    reader = (await make(s, ['notes:read'])).token;
  note(s.ctx, 'web-1', 'On the web', TODAY, { source: 'web' });
  const at = `/v1/notes/${TODAY}/web-1/place`;

  const refused = await call(s, 'PUT', at, token, { place: PARIS });
  assert.equal(refused.status, 403);
  assert.equal(refused.error.code, 'not_yours');
  assert.equal((await call(s, 'DELETE', at, token)).error.code, 'not_yours');
  assert.equal((await call(s, 'PUT', at, reader, { place: PARIS })).error.code, 'scope_required');

  assert.equal((await call(s, 'PUT', at, all, { place: PARIS })).status, 200);
  const read = (await call(s, 'GET', `/v1/notes/${TODAY}/web-1`, all)).json!;
  assert.equal((read.place as OAuthRow).city, 'Paris');
  assert.equal(read.source, 'web');
  assert.equal(read.text, 'On the web');
  assert.equal((await call(s, 'DELETE', at, all)).status, 200);
  assert.equal((await call(s, 'PUT', `/v1/notes/${TODAY}/nope/place`, all, { place: PARIS })).error.code, 'not_found');
});

test('a key sent again answers the first place, and writes nothing more', async () => {
  const s = setup(),
    { token } = await make(s, ['notes:write', 'notes:all']),
    made = await call(s, 'POST', '/v1/notes', token, { text: 'Dinner' }),
    at = `/v1/notes/${String(created(made).date)}/${String(created(made).id)}/place`,
    key = { 'idempotency-key': 'one' };
  const first = await call(s, 'PUT', at, token, { place: PARIS }, key),
    again = await call(s, 'PUT', at, token, { place: PARIS }, key);
  assert.equal(first.status, 200);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(again.json!.note, (first.json as OAuthRow).note);
  assert.equal(again.json!.unlocked, undefined, 'a badge is told once');
  assert.equal((await call(s, 'PUT', at, token, { place: OSLO }, key)).error.code, 'idempotency_mismatch');
});

test('a note changed while its place is written answers the revision it ends with', async () => {
  const s = setup(),
    { token } = await make(s, ['notes:write', 'notes:all']);
  note(s.ctx, 'web-2', 'First words', TODAY, { source: 'web' });
  const store = s.ctx.store as unknown as ApiStore,
    commit = store.apiNotePlace.bind(store);
  let raced = false;
  store.apiNotePlace = async (...args) => {
    if (!raced) {
      raced = true;
      note(s.ctx, 'web-2', 'Newer words', TODAY, { source: 'web', updated_at: '2026-10-13T09:00:00' });
    }
    return commit(...args);
  };
  const set = await call(s, 'PUT', `/v1/notes/${TODAY}/web-2/place`, token, { place: PARIS });
  assert.equal(set.status, 200, set.text);
  const read = (await call(s, 'GET', `/v1/notes/${TODAY}/web-2`, token)).json!;
  assert.equal(read.text, 'Newer words');
  assert.equal(created(set).revision, read.revision);
  assert.equal((read.place as OAuthRow).city, 'Paris');
});

test('a web edit of a token’s own note, while its place is written, is in the answer', async () => {
  const s = setup(),
    { token } = await make(s, ['notes:write']),
    made = await call(s, 'POST', '/v1/notes', token, { text: 'First words' }),
    id = String(created(made).id),
    store = s.ctx.store as unknown as ApiStore,
    commit = store.apiNotePlace.bind(store);
  let raced = false;
  store.apiNotePlace = async (...args) => {
    if (!raced) {
      raced = true;
      // As the web's edit: new words and last edit, the same revision.
      await s.ctx.store.updateNote('u', TODAY, id, 'Newer words', '2026-10-13T09:00:00');
    }
    return commit(...args);
  };
  const set = await call(s, 'PUT', `/v1/notes/${TODAY}/${id}/place`, token, { place: PARIS });
  assert.equal(set.status, 200, set.text);
  const read = (await call(s, 'GET', `/v1/notes/${TODAY}/${id}`, token)).json!;
  assert.equal(read.text, 'Newer words');
  assert.equal(created(set).revision, read.revision);
  // The revision answered is good for the next edit.
  const edit = await call(s, 'PUT', `/v1/notes/${TODAY}/${id}`, token, {
    text: 'Newest',
    revision: created(set).revision
  });
  assert.equal(edit.status, 200, edit.text);
});

test('a day’s own place takes notes:all, a city, and a day that can be written', async () => {
  const s = setup(),
    { token } = await make(s, ['notes:write']),
    all = (await make(s, ['notes:write', 'notes:all', 'activity'])).token,
    at = `/v1/days/${TODAY}/place`;

  const refused = await call(s, 'PUT', at, token, { place: PARIS });
  assert.equal(refused.status, 403);
  assert.equal(refused.error.code, 'scope_required');
  assert.equal((await call(s, 'DELETE', at, token)).error.code, 'scope_required');

  const set = await call(s, 'PUT', at, all, { place: PARIS });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json!.date, TODAY);
  assert.equal((set.json!.place as OAuthRow).city, 'Paris');
  assert.ok((set.json!.place as OAuthRow).label);
  const stored = (await s.ctx.store.dayPlace('u', TODAY, true)) as OAuthRow;
  assert.equal(stored.from, undefined, 'as the web keeps it');
  assert.equal(stored.city, 'Paris');
  const day = (await call(s, 'GET', `/v1/days/${TODAY}`, all)).json!;
  assert.equal((day.place as OAuthRow).city, 'Paris');

  const text = await call(s, 'PUT', at, all, { place: OSLO }, { accept: 'text/plain' });
  assert.match(text.text, /Oslo/);

  const device = await call(s, 'PUT', at, all, { place: SPOT });
  assert.equal(device.status, 400);
  assert.equal(device.error.field, 'place');

  const elsewhere = await call(s, 'PUT', at, all, { place: PARIS, date: EARLIER });
  assert.equal(elsewhere.error.field, 'date');
  assert.equal(elsewhere.error.message, 'The path names what this changes.');

  assert.equal((await call(s, 'PUT', '/v1/days/2026-10-14/place', all, { place: PARIS })).status, 400);
  assert.equal(
    (await call(s, 'PUT', '/v1/days/1900-01-01/place', all, { place: PARIS })).error.code,
    'date_out_of_range'
  );
  assert.equal((await call(s, 'PUT', '/v1/days/soon/place', all, { place: PARIS })).status, 400);

  assert.equal((await call(s, 'DELETE', at, all)).status, 204);
  assert.equal(await s.ctx.store.dayPlace('u', TODAY, true), null);
  assert.equal((await call(s, 'DELETE', at, all)).status, 204, 'nothing there to remove is still removed');

  const kinds = (await activity(s, all)).map((r) => r.kind);
  assert.ok(kinds.includes('place.set'));
  assert.ok(kinds.includes('place.removed'));
});

test('an earlier day’s weather follows where it was', async () => {
  const s = setup(),
    { token } = await make(s, ['notes:write', 'notes:all']),
    kept = async () => (await s.ctx.store.weatherBetween('u', EARLIER, EARLIER, true))[EARLIER] as OAuthRow | undefined;

  // A new note with a place on an earlier day brings the weather with it.
  const made = await call(s, 'POST', '/v1/notes', token, { text: 'Away', date: EARLIER, place: PARIS });
  assert.equal(made.status, 201, made.text);
  assert.equal(s.fetched.length, 1);
  assert.equal((await kept())?.city, 'Paris');

  // The note's place moves, and the weather with it.
  const at = `/v1/notes/${EARLIER}/${String(created(made).id)}/place`;
  await call(s, 'PUT', at, token, { place: OSLO });
  assert.equal(s.fetched.length, 2);
  assert.equal((await kept())?.city, 'Oslo');

  // A day's own place wins, as on the web.
  await call(s, 'PUT', `/v1/days/${EARLIER}/place`, token, { place: PARIS });
  assert.equal((await kept())?.city, 'Paris');
});

test('weather isn’t fetched for today, or for a new note with no place', async () => {
  const s = setup(),
    { token } = await make(s, ['notes:write', 'notes:all']);
  const today = await call(s, 'POST', '/v1/notes', token, { text: 'Here', place: PARIS });
  assert.equal(today.status, 201, today.text);
  await call(s, 'PUT', `/v1/days/${TODAY}/place`, token, { place: OSLO });
  await call(s, 'POST', '/v1/notes', token, { text: 'Back then', date: EARLIER });
  assert.deepEqual(s.fetched, []);
});

test('weather that can’t be had never fails the write', async () => {
  const s = setup(() => Promise.reject(new Error('Open-Meteo is down'))),
    { token } = await make(s, ['notes:write', 'notes:all']);
  const made = await call(s, 'POST', '/v1/notes', token, { text: 'Away', date: EARLIER, place: PARIS });
  assert.equal(made.status, 201, made.text);
  const at = `/v1/notes/${EARLIER}/${String(created(made).id)}/place`;
  assert.equal((await call(s, 'PUT', at, token, { place: OSLO })).status, 200);
  assert.equal((await call(s, 'PUT', `/v1/days/${EARLIER}/place`, token, { place: OSLO })).status, 200);
  assert.equal(
    ((await call(s, 'GET', `/v1/notes/${EARLIER}/${String(created(made).id)}`, token)).json!.place as OAuthRow).city,
    'Oslo'
  );
  assert.equal(s.logged.filter((f) => f.event === 'weather-error').length, 3);
  assert.equal(s.logged.find((f) => f.event === 'weather-error')!.date, EARLIER);
});
