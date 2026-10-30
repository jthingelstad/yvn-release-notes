/** Moments through `/v1` (docs/MOMENTS.md, API 1.6.0): a new note keeps
 * the moment an app picked, tidied, beside its words; the note's read
 * returns it, its activity row names the kinds and no word of it; a bad
 * one is refused at its field with nothing written; edits of the words
 * keep it and deleting the note takes it. Then the web's view and both
 * exports. Fictional account only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpApp, type McpOptions } from '../../server/mcp/app.ts';
import { captureNote } from '../../workers/capture.ts';
import { Tokens } from '../../packages/backend/tokens.ts';
import { noteView, dayView } from '../../packages/backend/views.ts';
import { build, markdown } from '../../packages/backend/export.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { fixture, ORIGIN, PROFILE } from '../oauth/fixtures.ts';

const TODAY = '2026-10-13',
  MOMENT = {
    at: '2026-10-11T07:40:00-05:00',
    items: [
      { kind: 'workout', activity: 'walking', distance_m: 5150, duration_s: 2890 },
      { kind: 'song', title: '  A Song ', artist: 'A Band' },
      { kind: 'people', names: ['Ana', 'Ben'] }
    ]
  },
  KEPT = {
    at: '2026-10-11T07:40:00-05:00',
    items: [
      { kind: 'workout', activity: 'walking', distance_m: 5150, duration_s: 2890 },
      { kind: 'song', title: 'A Song', artist: 'A Band' },
      { kind: 'people', names: ['Ana', 'Ben'] }
    ]
  };

function setup() {
  const ctx = { ...fixture(), objects: new FakeObjects() },
    logs: OAuthRow[] = [],
    options: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: (f) => logs.push(f) }),
      log: (f) => logs.push(f)
    };
  return { ctx, app: createMcpApp(options), logs };
}
type Setup = ReturnType<typeof setup>;
async function make(ctx: Setup['ctx']) {
  return (await new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now }).make('u', {
    name: 'Changelog',
    scopes: ['notes:write', 'activity'],
    expiry: 'never'
  })) as OAuthRow & { token: string; id: string };
}
async function call(app: Setup['app'], method: string, path: string, token: string, body?: unknown, key?: string) {
  const response = await app.request(ORIGIN + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    text = await response.text(),
    json = text ? (JSON.parse(text) as OAuthRow) : null;
  return { status: response.status, text, json, error: (json?.error ?? {}) as OAuthRow };
}
const notes = (s: Setup) =>
  s.ctx.store.memory.all().filter((r) => r.pk === 'USER#u' && String(r.sk).startsWith('NOTE#'));

test('a new note keeps its moment, tidied; its read returns it; its row names the kinds alone', async () => {
  const s = setup(),
    made = await make(s.ctx);
  const posted = await call(
    s.app,
    'POST',
    '/v1/notes',
    made.token,
    {
      text: 'Walked 3.2 mi in 48 min\nListened to A Song by A Band\nWith Ana and Ben',
      date: '2026-10-11',
      moment: MOMENT
    },
    'm-1'
  );
  assert.equal(posted.status, 201, posted.text);
  const id = String((posted.json!.note as OAuthRow).id),
    stored = notes(s)[0]!;
  assert.deepEqual(stored.moment, KEPT);
  // The words are still the note.
  assert.match(String(stored.text), /^Walked 3\.2 mi/);

  const read = await call(s.app, 'GET', `/v1/notes/2026-10-11/${id}`, made.token);
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(read.json!.moment, KEPT);

  const log = await call(s.app, 'GET', '/v1/activity', made.token),
    row = (log.json!.items as OAuthRow[]).find((i) => i.kind === 'note.added')!;
  assert.deepEqual(row.moment, ['workout', 'song', 'people']);
  for (const secret of ['A Song', 'A Band', 'Ana', '5150', 'Walked']) assert.ok(!log.text.includes(secret), secret);
  for (const line of s.logs) assert.ok(!JSON.stringify(line).includes('A Song'));

  // The same key with another moment is another request.
  const other = await call(
    s.app,
    'POST',
    '/v1/notes',
    made.token,
    {
      text: 'Walked 3.2 mi in 48 min\nListened to A Song by A Band\nWith Ana and Ben',
      date: '2026-10-11',
      moment: KEPT
    },
    'm-1'
  );
  assert.equal(other.status, 422, other.text);
  assert.equal(other.error.code, 'idempotency_mismatch');

  // A note without one reads as it did.
  const plain = await call(s.app, 'POST', '/v1/notes', made.token, { text: 'Just words' }, 'm-2');
  const plainRead = await call(
    s.app,
    'GET',
    `/v1/notes/${TODAY}/${String((plain.json!.note as OAuthRow).id)}`,
    made.token
  );
  assert.ok(!Object.hasOwn(plainRead.json!, 'moment'));
  const plainRow = ((await call(s.app, 'GET', '/v1/activity', made.token)).json!.items as OAuthRow[]).find(
    (i) => i.kind === 'note.added' && i.note === (plain.json!.note as OAuthRow).id
  )!;
  assert.ok(!Object.hasOwn(plainRow, 'moment'));
});

test('a bad moment is refused at its field, and nothing is written', async () => {
  const s = setup(),
    made = await make(s.ctx);
  for (const [moment, field] of [
    [{ items: [{ kind: 'workout', activity: 'walking', pace: 3 }] }, 'moment.items[0].pace'],
    [{ items: [{ kind: 'dance' }] }, 'moment.items[0].kind'],
    [{ items: [] }, 'moment.items'],
    ['a walk', 'moment']
  ] as const) {
    const r = await call(s.app, 'POST', '/v1/notes', made.token, { text: 'Words', moment }, 'bad-' + field);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.error.code, 'invalid_request');
    assert.equal(r.error.field, field);
  }
  // A moment rides on words or files; alone, it is no note.
  const alone = await call(s.app, 'POST', '/v1/notes', made.token, { moment: KEPT }, 'alone');
  assert.equal(alone.error.code, 'text_required');
  // Only a new note takes one.
  const posted = await call(s.app, 'POST', '/v1/notes', made.token, { text: 'Words' }, 'w');
  const path = `/v1/notes/${TODAY}/${String((posted.json!.note as OAuthRow).id)}`;
  const append = await call(s.app, 'POST', path + '/append', made.token, { text: 'More', moment: KEPT }, 'a');
  assert.equal(append.error.field, 'moment');
  assert.equal(notes(s).length, 1);
  assert.ok(!Object.hasOwn(notes(s)[0]!, 'moment'));
});

test('edits of the words keep the moment, from the token or the web; deleting the note takes it', async () => {
  const s = setup(),
    made = await make(s.ctx);
  const posted = await call(s.app, 'POST', '/v1/notes', made.token, { text: 'A walk', moment: MOMENT }, 'k-1'),
    note = posted.json!.note as OAuthRow,
    path = `/v1/notes/${TODAY}/${String(note.id)}`;
  const appended = await call(s.app, 'POST', path + '/append', made.token, { text: 'Then tea.' }, 'k-2');
  assert.equal(appended.status, 200, appended.text);
  const edited = await call(
    s.app,
    'PUT',
    path,
    made.token,
    { text: 'A long walk', revision: (appended.json!.note as OAuthRow).revision },
    'k-3'
  );
  assert.equal(edited.status, 200, edited.text);
  assert.deepEqual(notes(s)[0]!.moment, KEPT);
  await s.ctx.store.updateNote('u', TODAY, String(note.id), 'Fixed on the web', '2026-10-13T12:30:00Z');
  assert.equal(notes(s)[0]!.text, 'Fixed on the web');
  assert.deepEqual(notes(s)[0]!.moment, KEPT);

  const deleted = await call(s.app, 'DELETE', path, made.token, undefined, 'k-4');
  assert.equal(deleted.status, 204, deleted.text);
  assert.equal(notes(s).length, 0);
  assert.ok(!JSON.stringify(s.ctx.store.memory.all()).includes('A Band'));
});

test('the web’s view carries the moment as kept, and both exports keep it', async () => {
  const item = {
      pk: 'USER#u',
      sk: `NOTE#${TODAY}#t-1`,
      source: 'api',
      token: 'Changelog',
      text: 'A walk by the lake',
      written_at: '2026-10-13T13:00:00Z',
      tz: 'America/Chicago',
      moment: KEPT
    },
    bare = { ...item, sk: `NOTE#${TODAY}#t-2`, text: 'Words', moment: undefined },
    unreadable = { ...item, sk: `NOTE#${TODAY}#t-3`, moment: { items: [{ kind: 'dance' }] } };
  const view = await noteView(item, 'America/Chicago');
  assert.deepEqual(view.moment, KEPT);
  assert.ok(!Object.hasOwn(await noteView(bare, 'America/Chicago'), 'moment'));
  // What can't be read as a moment shows as none, never as an error.
  assert.ok(!Object.hasOwn(await noteView(unreadable, 'America/Chicago'), 'moment'));
  const day = await dayView(PROFILE, TODAY, [item, bare]);
  assert.deepEqual((day.notes as OAuthRow[])[0]!.moment, KEPT);

  const profile = { ...PROFILE, country: 'United States' },
    data = build([profile, item, bare], '2026-10-13T20:00:00Z'),
    [withMoment, without] = data.notes;
  assert.deepEqual(withMoment!.moment, KEPT);
  assert.ok(!Object.hasOwn(without!, 'moment'));
  const md = markdown(data);
  assert.ok(md.includes('Moment: Walk · 3\\.2 mi · 48 min; A Song · A Band; With Ana and Ben'), md);
  const km = markdown(build([{ ...profile, country: 'Switzerland' }, item], '2026-10-13T20:00:00Z'));
  assert.ok(km.includes('Walk · 5\\.2 km · 48 min'), km);
});
