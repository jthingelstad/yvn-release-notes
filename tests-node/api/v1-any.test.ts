/** A token that may reach all the account's notes (notes:all, API 1.10.0,
 * issue #279): it reads, lists and rewrites notes from any channel, the
 * web's and email's too, while deleting and adding files stay with its own
 * notes and another account's notes stay out of reach. Fictional accounts
 * only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpApp, type McpOptions } from '../../server/mcp/app.ts';
import { captureNote } from '../../workers/capture.ts';
import { Tokens } from '../../packages/backend/tokens.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { fixture, note, ORIGIN } from '../oauth/fixtures.ts';

const TODAY = '2026-10-13';
type Made = OAuthRow & { token: string; id: string };

function setup() {
  const ctx = { ...fixture(), objects: new FakeObjects() },
    options: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: () => {} })
    };
  return { ctx, app: createMcpApp(options) };
}
type Ctx = ReturnType<typeof setup>['ctx'];
const make = async (ctx: Ctx, scopes: string[], name = 'Changelog', uid = 'u') =>
  (await new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now }).make(uid, {
    name,
    scopes,
    expiry: 'never'
  })) as Made;
async function call(app: ReturnType<typeof setup>['app'], method: string, path: string, token: string, body?: unknown) {
  const response = await app.request(ORIGIN + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    text = await response.text(),
    json = text ? (JSON.parse(text) as OAuthRow) : null;
  return { status: response.status, json, error: (json?.error ?? {}) as OAuthRow };
}
const noteOf = (r: { json: OAuthRow | null }) => r.json!.note as OAuthRow,
  bare = (r: { json: OAuthRow | null }) => r.json!;

test('notes:all reads and lists every note, and rewrites and appends to the web’s and email’s', async () => {
  const { ctx, app } = setup(),
    all = await make(ctx, ['notes:write', 'notes:all']),
    other = await make(ctx, ['notes:write'], 'Other');
  // A web note with no revision yet, an email note, and one with files only.
  note(ctx, 'w-web', 'Written on the web', TODAY, { source: 'web' });
  note(ctx, 'e-mail', 'Sent by email', TODAY, { written_at: TODAY + 'T13:00:00Z' });
  ctx.store.seed({ pk: 'USER#u', sk: `NOTE#${TODAY}#w-photo`, source: 'web', written_at: TODAY + 'T14:00:00Z' });
  const theirs = noteOf(await call(app, 'POST', '/v1/notes', other.token, { text: 'Theirs' }));

  const web = await call(app, 'GET', `/v1/notes/${TODAY}/w-web`, all.token);
  assert.equal(web.status, 200);
  assert.deepEqual([bare(web).source, bare(web).mine, bare(web).text], ['web', false, 'Written on the web']);
  const mail = bare(await call(app, 'GET', `/v1/notes/${TODAY}/e-mail`, all.token));
  assert.deepEqual([mail.source, mail.mine], ['email', false]);

  const listed = await call(app, 'GET', `/v1/notes?from=${TODAY}`, all.token);
  assert.deepEqual(
    (listed.json!.items as OAuthRow[]).map((n) => n.id),
    [theirs.id, 'w-web', 'e-mail', 'w-photo']
  );
  const only = await call(app, 'GET', `/v1/notes?from=${TODAY}&mine=true`, all.token);
  assert.deepEqual(only.json!.items, []);
  assert.equal((await call(app, 'GET', `/v1/notes?from=${TODAY}&mine=yes`, all.token)).error.field, 'mine');

  // Rewrites, from the revision read; a stale one is refused as before.
  const stale = await call(app, 'PUT', `/v1/notes/${TODAY}/w-web`, all.token, { text: 'x', revision: 'old' });
  assert.equal(stale.error.code, 'revision_mismatch');
  const edited = await call(app, 'PUT', `/v1/notes/${TODAY}/w-web`, all.token, {
    text: 'Rewritten in the app',
    revision: bare(web).revision
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  const row = await ctx.store.note('u', TODAY, 'w-web', true);
  assert.equal(row!.text, 'Rewritten in the app');
  // The note stays the web's: its channel is where it was made.
  assert.equal(row!.source, 'web');
  assert.equal(bare(await call(app, 'GET', `/v1/notes/${TODAY}/w-web`, all.token)).source, 'web');

  const appended = await call(app, 'POST', `/v1/notes/${TODAY}/e-mail/append`, all.token, { text: 'And later' });
  assert.equal(appended.status, 200, JSON.stringify(appended.json));
  assert.equal((await ctx.store.note('u', TODAY, 'e-mail', true))!.text, 'Sent by email\n\nAnd later');
  // A note with no words yet takes some.
  const photo = bare(await call(app, 'GET', `/v1/notes/${TODAY}/w-photo`, all.token));
  const worded = await call(app, 'PUT', `/v1/notes/${TODAY}/w-photo`, all.token, {
    text: 'The view',
    revision: photo.revision
  });
  assert.equal(worded.status, 200, JSON.stringify(worded.json));
  const theirsEdit = await call(app, 'POST', `/v1/notes/${TODAY}/${String(theirs.id)}/append`, all.token, {
    text: 'From the app'
  });
  assert.equal(theirsEdit.status, 200);

  // Deleting stays with a token's own notes.
  for (const id of ['w-web', 'e-mail', String(theirs.id)]) {
    const r = await call(app, 'DELETE', `/v1/notes/${TODAY}/${id}`, all.token);
    assert.equal(r.error.code, 'not_yours', id);
  }
  assert.ok(await ctx.store.note('u', TODAY, 'w-web', true));
});

test('without notes:all a token still reaches only its own', async () => {
  const { ctx, app } = setup(),
    plain = await make(ctx, ['notes:write']);
  note(ctx, 'w-web', 'Written on the web', TODAY, { source: 'web' });
  assert.equal((await call(app, 'GET', `/v1/notes/${TODAY}/w-web`, plain.token)).error.code, 'not_yours');
  const put = await call(app, 'PUT', `/v1/notes/${TODAY}/w-web`, plain.token, { text: 'x', revision: 'r' });
  assert.equal(put.error.code, 'not_yours');
  assert.deepEqual((await call(app, 'GET', `/v1/notes?from=${TODAY}`, plain.token)).json!.items, []);
});

test('notes:all never reaches another account’s notes', async () => {
  const { ctx, app } = setup(),
    all = await make(ctx, ['notes:write', 'notes:all']);
  ctx.store.seed({
    pk: 'USER#v',
    sk: `NOTE#${TODAY}#w-v`,
    text: 'Not yours',
    source: 'web',
    written_at: TODAY + 'T12:00:00Z'
  });
  assert.equal((await call(app, 'GET', `/v1/notes/${TODAY}/w-v`, all.token)).error.code, 'not_found');
  const put = await call(app, 'PUT', `/v1/notes/${TODAY}/w-v`, all.token, { text: 'x', revision: 'r' });
  assert.equal(put.error.code, 'not_found');
  assert.deepEqual((await call(app, 'GET', `/v1/notes?from=${TODAY}`, all.token)).json!.items, []);
});
