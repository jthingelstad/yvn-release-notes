/** Reading back through `/v1` by day (API 1.9.0, issue #278): the notes a
 * token wrote across a range of days, a page at a time; a note's files and
 * a short-lived address for each; and the activity log for some days.
 * Fictional account and fake bucket only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpApp, type McpOptions } from '../../server/mcp/app.ts';
import { FILE_SECONDS, RANGE_DAYS_MAX } from '../../server/mcp/v1.ts';
import { captureNote } from '../../workers/capture.ts';
import { Tokens } from '../../packages/backend/tokens.ts';
import { activityKey, activityTime } from '../../packages/domain/activity.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { fixture, note, ORIGIN } from '../oauth/fixtures.ts';

const TODAY = '2026-10-13';

function setup() {
  const signed: string[] = [],
    ctx = {
      ...fixture(),
      objects: new FakeObjects(),
      media: {
        download: async (uid: string, key: string, type: string, seconds: number) => {
          signed.push(`${uid} ${key} ${type} ${seconds}`);
          return `https://files.example/${key}?signed=${seconds}`;
        },
        bytes: async () => new Uint8Array()
      }
    },
    options: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: () => {} })
    };
  return { ctx, app: createMcpApp(options), signed };
}
type Ctx = ReturnType<typeof setup>['ctx'];
const make = async (ctx: Ctx, name = 'Changelog', scopes = ['notes:write', 'media:write', 'activity']) =>
  (await new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now }).make('u', {
    name,
    scopes,
    expiry: 'never'
  })) as OAuthRow & { token: string; id: string };
async function get(app: ReturnType<typeof setup>['app'], path: string, token: string, plain = false) {
  const response = await app.request(ORIGIN + path, {
      headers: { authorization: 'Bearer ' + token, ...(plain ? { accept: 'text/plain' } : {}) }
    }),
    text = await response.text();
  const json = plain ? null : (JSON.parse(text) as OAuthRow);
  return { status: response.status, text, json, error: (json?.error ?? {}) as OAuthRow };
}
const mine = (ctx: Ctx, id: string, day: string, at: string, tid: string, extra: OAuthRow = {}) =>
  note(ctx, id, `Note ${id}`, day, { source: 'api', connection: tid, token: 'Changelog', written_at: at, ...extra });

test('GET /v1/notes lists only this token’s notes on the days asked, oldest first, a page at a time', async () => {
  const { ctx, app } = setup(),
    token = await make(ctx),
    other = await make(ctx, 'Other');
  const post = async (who: string, text: string, at: string) => {
    const r = await app.request(ORIGIN + '/v1/notes', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + who, 'content-type': 'application/json' },
      body: JSON.stringify({ text, written_at: at })
    });
    assert.equal(r.status, 201);
    return String(((await r.json()) as { note: OAuthRow }).note.id);
  };
  // Chicago is UTC-5 in October.
  const b = await post(token.token, 'Evening', '2026-10-12T20:00:00Z'),
    a = await post(token.token, 'Morning', '2026-10-12T14:00:00Z'),
    c = await post(token.token, 'Today', '2026-10-13T09:00:00Z'),
    old = await post(token.token, 'Earlier', '2026-10-01T15:00:00Z');
  await post(other.token, 'Theirs', '2026-10-12T15:00:00Z');
  note(ctx, 'w-web', 'Written on the web', '2026-10-12', { source: 'web' });
  const ids = (r: Awaited<ReturnType<typeof get>>) => (r.json!.items as OAuthRow[]).map((n) => n.id);

  const one = await get(app, '/v1/notes?from=2026-10-12', token.token);
  assert.equal(one.status, 200);
  assert.equal(one.json!.from, '2026-10-12');
  assert.equal(one.json!.to, '2026-10-12');
  assert.deepEqual(ids(one), [a, b]);
  const first = (one.json!.items as OAuthRow[])[0]!;
  assert.deepEqual(Object.keys(first).sort(), [
    'date',
    'files',
    'id',
    'media',
    'revision',
    'text',
    'token',
    'version',
    'written_at'
  ]);
  assert.deepEqual(
    { text: first.text, date: first.date, token: first.token, files: first.files, media: first.media },
    { text: 'Morning', date: '2026-10-12', token: 'Changelog', files: 0, media: [] }
  );
  // Read alone, a note is the same.
  assert.deepEqual((await get(app, `/v1/notes/2026-10-12/${String(a)}`, token.token)).json, first);
  assert.equal(one.json!.next, null);
  // The words of a note from another channel or token never come.
  assert.ok(!one.text.includes('Written on the web') && !one.text.includes('Theirs'));

  // A page ends where it ends, and the next one starts after it.
  const p1 = await get(app, '/v1/notes?from=2026-10-01&to=2026-10-13&limit=2', token.token);
  assert.deepEqual(ids(p1), [old, a]);
  assert.equal(typeof p1.json!.next, 'string');
  // A note deleted since the page was read doesn't move where the next one starts.
  const gone = await app.request(ORIGIN + `/v1/notes/2026-10-12/${a}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer ' + token.token }
  });
  assert.equal(gone.status, 204);
  const p2 = await get(
    app,
    `/v1/notes?from=2026-10-01&to=2026-10-13&limit=2&after=${String(p1.json!.next)}`,
    token.token
  );
  assert.deepEqual(ids(p2), [b, c]);
  assert.equal(p2.json!.next, null);

  // Nothing on those days is an empty list, not a 404.
  const none = await get(app, '/v1/notes?from=2026-09-01&to=2026-09-30', token.token);
  assert.deepEqual(none.json, { from: '2026-09-01', to: '2026-09-30', items: [], next: null });

  // Text: a line a note, its day and its words.
  const plain = await get(app, '/v1/notes?from=2026-10-12&to=2026-10-13', token.token, true);
  assert.equal(plain.text, '2026-10-12 Evening\n2026-10-13 Today\n');
});

test('GET /v1/notes refuses a range it can’t read: wide, backwards, malformed, no from', async () => {
  const { ctx, app } = setup(),
    token = await make(ctx);
  const wide = await get(app, '/v1/notes?from=2026-09-01&to=2026-10-02', token.token);
  assert.equal(wide.status, 400);
  assert.equal(wide.error.code, 'range_too_wide');
  assert.match(String(wide.error.message), new RegExp(`${RANGE_DAYS_MAX} days`));
  // Exactly the most days is fine.
  assert.equal((await get(app, '/v1/notes?from=2026-09-01&to=2026-10-01', token.token)).status, 200);
  for (const [query, field] of [
    ['', 'from'],
    ['?to=2026-10-12', 'from'],
    ['?from=2026-10-13&to=2026-10-12', 'to'],
    ['?from=2026-13-01', 'from'],
    ['?from=2026-10-12&to=yesterday', 'to'],
    ['?from=2026-10-12&limit=101', 'limit'],
    ['?from=2026-10-12&after=nope', 'after']
  ] as const) {
    const r = await get(app, '/v1/notes' + query, token.token);
    assert.equal(r.status, 400, query);
    assert.equal(r.error.code, 'invalid_request', query);
    assert.equal(r.error.field, field, query);
  }
  const bare = await make(ctx, 'Bare', ['activity']);
  assert.equal((await get(app, '/v1/notes?from=2026-10-12', bare.token)).error.code, 'scope_required');
});

test('a note lists its files, and a token gets a short-lived address for one on its own note', async () => {
  const { ctx, app, signed } = setup(),
    token = await make(ctx),
    other = await make(ctx, 'Other');
  mine(ctx, 't-photo', TODAY, '2026-10-13T09:00:00Z', token.id, {
    media: [
      {
        n: 1,
        kind: 'image',
        type: 'image/jpeg',
        name: 'lake.jpg',
        size: 2048,
        key: 'media/u/api/lake.jpg',
        thumb: { key: 'media/u/api/lake.thumb.jpg', size: 30, width: 640, height: 480 }
      },
      { n: 2, kind: 'audio', type: 'audio/mp4', size: 4096, key: 'media/u/api/memo.m4a' }
    ]
  });
  mine(ctx, 't-theirs', TODAY, '2026-10-13T10:00:00Z', other.id, {
    media: [{ n: 1, kind: 'image', type: 'image/jpeg', size: 1, key: 'media/u/api/x.jpg' }]
  });

  const read = await get(app, `/v1/notes/${TODAY}/t-photo`, token.token);
  assert.equal(read.json!.files, 2);
  assert.deepEqual(read.json!.media, [
    {
      n: 1,
      kind: 'image',
      type: 'image/jpeg',
      name: 'lake.jpg',
      size: 2048,
      thumb: { type: 'image/jpeg', width: 640, height: 480 }
    },
    { n: 2, kind: 'audio', type: 'audio/mp4', name: null, size: 4096, thumb: null }
  ]);
  // Where a file is kept never comes with the note.
  assert.ok(!read.text.includes('media/u/'));

  const original = await get(app, `/v1/notes/${TODAY}/t-photo/media/1`, token.token);
  assert.equal(original.status, 200);
  assert.deepEqual(original.json, {
    url: `https://files.example/media/u/api/lake.jpg?signed=${FILE_SECONDS}`,
    type: 'image/jpeg',
    expires_in: FILE_SECONDS
  });
  const thumb = await get(app, `/v1/notes/${TODAY}/t-photo/media/1?size=thumb`, token.token);
  assert.equal(thumb.json!.url, `https://files.example/media/u/api/lake.thumb.jpg?signed=${FILE_SECONDS}`);
  const memo = await get(app, `/v1/notes/${TODAY}/t-photo/media/2`, token.token);
  assert.equal(memo.json!.type, 'audio/mp4');
  assert.deepEqual(signed, [
    `u media/u/api/lake.jpg image/jpeg ${FILE_SECONDS}`,
    `u media/u/api/lake.thumb.jpg image/jpeg ${FILE_SECONDS}`,
    `u media/u/api/memo.m4a audio/mp4 ${FILE_SECONDS}`
  ]);

  // A recording has no small copy; a number the note lacks, or a size it
  // doesn't know, is refused; another token's note is never reached.
  assert.equal((await get(app, `/v1/notes/${TODAY}/t-photo/media/2?size=thumb`, token.token)).error.code, 'not_found');
  assert.equal((await get(app, `/v1/notes/${TODAY}/t-photo/media/3`, token.token)).error.code, 'not_found');
  assert.equal((await get(app, `/v1/notes/${TODAY}/t-photo/media/1?size=large`, token.token)).error.field, 'size');
  assert.equal((await get(app, `/v1/notes/${TODAY}/t-theirs/media/1`, token.token)).error.code, 'not_yours');
  assert.equal((await get(app, `/v1/notes/${TODAY}/t-none/media/1`, token.token)).error.code, 'not_found');
  assert.equal(signed.length, 3);
});

test('GET /v1/activity takes from and to, days in the account’s time zone', async () => {
  const { ctx, app } = setup(),
    token = await make(ctx);
  const row = (iso: string, id: string) =>
    ctx.store.seed({
      pk: 'USER#u',
      sk: activityKey(activityTime(Date.parse(iso) / 1000), 'note.added', id),
      kind: 'note.added',
      via: 'web',
      day: '2026-10-12',
      note: id
    });
  // Chicago is UTC-5 in October: 04:00Z is the evening before.
  row('2026-10-12T04:00:00Z', 'w-sunday');
  row('2026-10-12T06:00:00Z', 'w-early');
  row('2026-10-13T04:59:00Z', 'w-late');
  row('2026-10-13T11:00:00Z', 'w-today');
  const notes = (r: Awaited<ReturnType<typeof get>>) => (r.json!.items as OAuthRow[]).map((i) => i.note);

  const monday = await get(app, '/v1/activity?kinds=note&from=2026-10-12', token.token);
  assert.equal(monday.status, 200);
  assert.deepEqual(notes(monday), ['w-late', 'w-early']);
  const both = await get(app, '/v1/activity?kinds=note&from=2026-10-12&to=2026-10-13', token.token);
  assert.deepEqual(notes(both), ['w-today', 'w-late', 'w-early']);
  // A page within the days, then the rest of them.
  const p1 = await get(app, '/v1/activity?kinds=note&from=2026-10-11&to=2026-10-12&limit=1', token.token);
  assert.deepEqual(notes(p1), ['w-late']);
  const p2 = await get(
    app,
    `/v1/activity?kinds=note&from=2026-10-11&to=2026-10-12&limit=5&before=${encodeURIComponent(String(p1.json!.next))}`,
    token.token
  );
  assert.deepEqual(notes(p2), ['w-early', 'w-sunday']);
  assert.equal(p2.json!.next, null);
  // after and from together: the later of the two holds.
  const seen = (both.json!.items as OAuthRow[])[1]!.id as string;
  const newer = await get(
    app,
    `/v1/activity?kinds=note&from=2026-10-12&to=2026-10-13&after=${encodeURIComponent(seen)}`,
    token.token
  );
  assert.deepEqual(notes(newer), ['w-today']);

  const wide = await get(app, '/v1/activity?from=2026-09-01&to=2026-10-13', token.token);
  assert.equal(wide.error.code, 'range_too_wide');
  assert.equal((await get(app, '/v1/activity?to=2026-10-12', token.token)).error.field, 'from');
  // Without days, the log reads as before.
  assert.deepEqual(notes(await get(app, '/v1/activity?kinds=note', token.token)), [
    'w-today',
    'w-late',
    'w-early',
    'w-sunday'
  ]);
});
