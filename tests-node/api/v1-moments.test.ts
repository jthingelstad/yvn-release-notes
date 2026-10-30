/** Moments were withdrawn in API 1.8.0 (docs/MOMENTS.md; Jamie, 2026-10-30:
 * "they should not form our API"): `POST /v1/notes` refuses `moment` as a
 * field it doesn't have and writes nothing, and the same note without it
 * files as words. Nothing reads one either: an item that somehow carries the
 * attribute shows none on the token's read, the web's view or the exports.
 * Fictional account only. */
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
  TEXT = 'Walked 3.2 mi in 48 min\nListened to A Song by A Band\nWith Ana and Ben',
  MOMENT = {
    at: '2026-10-11T07:40:00-05:00',
    items: [
      { kind: 'workout', activity: 'walking', distance_m: 5150, duration_s: 2890 },
      { kind: 'song', title: 'A Song', artist: 'A Band' },
      { kind: 'people', names: ['Ana', 'Ben'] }
    ]
  };

function setup() {
  const ctx = { ...fixture(), objects: new FakeObjects() },
    options: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: () => {} }),
      log: () => {}
    };
  return { ctx, app: createMcpApp(options) };
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

test('a moment is refused as a field a note doesn’t have, and nothing is written', async () => {
  const s = setup(),
    made = await make(s.ctx);
  const refused = await call(s.app, 'POST', '/v1/notes', made.token, { text: TEXT, moment: MOMENT }, 'm-1');
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.error.code, 'invalid_request');
  assert.equal(refused.error.field, 'moment');
  assert.equal(notes(s).length, 0);

  // The words alone are the note, and nothing about it says moment.
  const posted = await call(s.app, 'POST', '/v1/notes', made.token, { text: TEXT }, 'm-2');
  assert.equal(posted.status, 201, posted.text);
  const path = `/v1/notes/${TODAY}/${String((posted.json!.note as OAuthRow).id)}`;
  assert.ok(!Object.hasOwn((await call(s.app, 'GET', path, made.token)).json!, 'moment'));
  const row = ((await call(s.app, 'GET', '/v1/activity', made.token)).json!.items as OAuthRow[]).find(
    (i) => i.kind === 'note.added'
  )!;
  assert.ok(!Object.hasOwn(row, 'moment'));
  assert.ok(!Object.hasOwn(notes(s)[0]!, 'moment'));

  // Append and edit never took one.
  const append = await call(s.app, 'POST', path + '/append', made.token, { text: 'More', moment: MOMENT }, 'm-3');
  assert.equal(append.error.field, 'moment');
});

test('nothing reads a moment: the token’s read, the web’s view and both exports show none', async () => {
  const s = setup(),
    made = await make(s.ctx);
  const posted = await call(s.app, 'POST', '/v1/notes', made.token, { text: TEXT }, 'r-1'),
    id = String((posted.json!.note as OAuthRow).id),
    stored = notes(s)[0]!;
  // As if one had been kept before the withdrawal (none was, on the live table).
  s.ctx.store.seed({ ...stored, moment: MOMENT });
  assert.ok(!Object.hasOwn((await call(s.app, 'GET', `/v1/notes/${TODAY}/${id}`, made.token)).json!, 'moment'));

  const item = { ...notes(s)[0]! };
  assert.deepEqual(item.moment, MOMENT);
  assert.ok(!Object.hasOwn(await noteView(item, 'America/Chicago'), 'moment'));
  const day = await dayView(PROFILE, TODAY, [item]);
  assert.ok(!Object.hasOwn((day.notes as OAuthRow[])[0]!, 'moment'));
  const data = build([{ ...PROFILE, country: 'United States' }, item], '2026-10-13T20:00:00Z');
  assert.ok(!Object.hasOwn(data.notes[0]!, 'moment'));
  const md = markdown(data);
  assert.ok(!md.includes('Moment'), md);
  assert.ok(md.includes('Walked 3.2 mi in 48 min\nListened to A Song by A Band\nWith Ana and Ben'), md);
});
