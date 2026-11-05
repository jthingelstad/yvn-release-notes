/** Taking one file off a note (API 1.17.0): through a token as the capture
 * function runs it, then on the web. The others keep their numbers, and the
 * file's bytes, small copy and leases go with it. Fictional account and fake
 * bucket only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureNote } from '../../workers/capture.ts';
import { V1_ROUTES } from '../../server/mcp/v1.ts';
import { Tokens } from '../../packages/backend/tokens.ts';
import * as media from '../../packages/backend/media.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { png } from '../../packages/testing/images.ts';
import { fixture } from '../oauth/fixtures.ts';

function setup() {
  const objects = new FakeObjects(),
    ctx = { ...fixture(), objects },
    write = async (token: string, api: string, args: OAuthRow, key: string | null = null) =>
      (await captureNote({ api, token, arguments: args, key, client: 'Changelog' }, ctx, {
        fetchTitle: () => null,
        log: () => undefined
      })) as OAuthRow;
  return { ctx, objects, write };
}
type Setup = ReturnType<typeof setup>;
const make = async (s: Setup, scopes = ['notes:write', 'media:write'], name = 'Changelog') =>
  (await new Tokens({ store: s.ctx.store, origin: s.ctx.origin, now: s.ctx.now }).make('u', {
    name,
    scopes,
    expiry: 'never'
  })) as OAuthRow & { token: string; id: string };
async function upload(s: Setup, token: string, name: string) {
  const bytes = png(),
    form = await s.write(token, 'uploads.start', { name, type: 'image/png', size: bytes.length });
  assert.equal(form.status, 201, JSON.stringify(form));
  const body = form.body as OAuthRow;
  await s.objects.put(String((body.fields as OAuthRow).key), bytes, {
    type: 'image/png',
    tags: { outcome: 'pending' }
  });
  return { upload: String(body.upload), type: 'image/png', name };
}
const row = (s: Setup) => s.ctx.store.memory.all().find((r) => r.pk === 'USER#u' && String(r.sk).startsWith('NOTE#'))!;
const live = (s: Setup, key: string) => {
  const last = s.objects.versions.get(key)?.at(-1);
  return Boolean(last && !last.deleted);
};
/** A note this token wrote, with words if asked, and two files. */
async function pictured(s: Setup, token: string, text?: string) {
  const uploads = [await upload(s, token, 'one.png'), await upload(s, token, 'two.png')],
    made = await s.write(token, 'notes.create', { ...(text ? { text } : {}), uploads });
  assert.equal(made.status, 201, JSON.stringify(made));
  const note = (made.body as OAuthRow).note as OAuthRow;
  return { date: String(note.date), id: String(note.id), revision: note.revision };
}

test('one file comes off with its small copy; the other keeps its number', async () => {
  const s = setup(),
    t = await make(s),
    at = await pictured(s, t.token, 'Lake day'),
    [one, two] = row(s).media as OAuthRow[],
    thumb = media.thumbKey(String(one!.key));
  await s.objects.put(thumb, Buffer.from('thumb'), { type: 'image/jpeg' });
  s.ctx.now += 5;
  const gone = await s.write(t.token, 'notes.media.remove', { date: at.date, id: at.id, n: 1 });
  assert.equal(gone.status, 200, JSON.stringify(gone));
  assert.equal(((gone.body as OAuthRow).note as OAuthRow).files, 1);
  assert.deepEqual(
    (row(s).media as OAuthRow[]).map((m) => m.n),
    [2]
  );
  assert.ok(!live(s, String(one!.key)));
  assert.ok(!live(s, thumb));
  assert.ok(live(s, String(two!.key)));
  assert.notEqual(((gone.body as OAuthRow).note as OAuthRow).revision, at.revision);
  const logged = s.ctx.store.memory.all().filter((r) => r.kind === 'note.files' && r.removed);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.removed, 1);
  assert.equal(logged[0]!.added, undefined);
});

test('a missing number is not_found, and a note with no words keeps its last file', async () => {
  const s = setup(),
    t = await make(s),
    at = await pictured(s, t.token);
  const none = await s.write(t.token, 'notes.media.remove', { date: at.date, id: at.id, n: 9 });
  assert.equal(none.error, 'not_found', JSON.stringify(none));
  s.ctx.now += 5;
  assert.equal((await s.write(t.token, 'notes.media.remove', { date: at.date, id: at.id, n: 1 })).status, 200);
  s.ctx.now += 5;
  const last = await s.write(t.token, 'notes.media.remove', { date: at.date, id: at.id, n: 2 });
  assert.equal(last.error, 'text_required', JSON.stringify(last));
  assert.equal((row(s).media as OAuthRow[]).length, 1);
});

test('a note with words can lose its last file, and has no list left', async () => {
  const s = setup(),
    t = await make(s),
    at = await pictured(s, t.token, 'Lake day');
  for (const n of [1, 2]) {
    s.ctx.now += 5;
    assert.equal((await s.write(t.token, 'notes.media.remove', { date: at.date, id: at.id, n })).status, 200);
  }
  assert.equal('media' in row(s), false);
  assert.equal(row(s).text, 'Lake day');
});

test('removing needs media:write, and notes:all on a note another token wrote', async () => {
  const s = setup(),
    mine = await make(s),
    at = await pictured(s, mine.token, 'Lake day'),
    words = await make(s, ['notes:write'], 'Words'),
    other = await make(s, ['notes:write', 'media:write'], 'Other'),
    all = await make(s, ['notes:write', 'media:write', 'notes:all'], 'All');
  const refused = await s.write(words.token, 'notes.media.remove', { date: at.date, id: at.id, n: 1 });
  assert.ok(refused.error, JSON.stringify(refused));
  assert.notEqual(refused.status, 200);
  const notYours = await s.write(other.token, 'notes.media.remove', { date: at.date, id: at.id, n: 1 });
  assert.equal(notYours.error, 'not_yours', JSON.stringify(notYours));
  assert.equal((row(s).media as OAuthRow[]).length, 2);
  s.ctx.now += 5;
  assert.equal((await s.write(all.token, 'notes.media.remove', { date: at.date, id: at.id, n: 1 })).status, 200);
  assert.equal((row(s).media as OAuthRow[]).length, 1);
});

test('the same key answers the same way, and removes nothing twice', async () => {
  const s = setup(),
    t = await make(s),
    at = await pictured(s, t.token, 'Lake day'),
    first = await s.write(t.token, 'notes.media.remove', { date: at.date, id: at.id, n: 1 }, 'k-1'),
    again = await s.write(t.token, 'notes.media.remove', { date: at.date, id: at.id, n: 1 }, 'k-1');
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
  assert.equal(s.ctx.store.memory.all().filter((r) => r.kind === 'note.files' && r.removed).length, 1);
});

test('a removed number never comes round, and nothing about it shows', async () => {
  const s = setup(),
    t = await make(s),
    at = await pictured(s, t.token, 'Lake day'),
    gone = await s.write(t.token, 'notes.media.remove', { date: at.date, id: at.id, n: 2 });
  assert.equal(gone.status, 200, JSON.stringify(gone));
  assert.deepEqual(row(s).media_gone, [2]);
  assert.equal(JSON.stringify(gone.body).includes('media_gone'), false);
  s.ctx.now += 5;
  const next = await s.write(t.token, 'notes.media', {
    date: at.date,
    id: at.id,
    uploads: [await upload(s, t.token, 'three.png')]
  });
  assert.equal(next.status, 200, JSON.stringify(next));
  assert.deepEqual(
    (row(s).media as OAuthRow[]).map((m) => m.n),
    [1, 3]
  );
  // Nor when the note has lost every file.
  for (const n of [1, 3]) {
    s.ctx.now += 5;
    assert.equal((await s.write(t.token, 'notes.media.remove', { date: at.date, id: at.id, n })).status, 200);
  }
  assert.equal(media.nextFile(row(s)), 4);
});

test('a note far along in its numbers still has every file reachable', () => {
  const file = V1_ROUTES.find((r) => r.name === 'notes.media.remove')!;
  assert.ok(file.path.test('/v1/notes/2026-10-13/t-a/media/1000'));
  assert.ok(!file.path.test('/v1/notes/2026-10-13/t-a/media/0'));
});
