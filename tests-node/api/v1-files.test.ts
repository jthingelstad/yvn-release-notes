/** Files and places through `/v1` (docs/API.md, Phase 3), as the capture
 * function runs them: a signed form under the owner's media/<user>/api/,
 * counted with the web's uploads; a note that takes the uploaded files as a
 * web note does, removing the pending file only once it has its copy; files
 * added to a token's own note; a note's place; and Here. Then the routes
 * that reach them, and the city search the router answers itself.
 * Fictional account and fake bucket only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpApp } from '../../server/mcp/app.ts';
import { API_VERSION } from '../../server/mcp/v1.ts';
import { captureNote } from '../../workers/capture.ts';
import { SCOPE_REFUSALS, Tokens, V1_LIMITS } from '../../packages/backend/tokens.ts';
import * as media from '../../packages/backend/media.ts';
import { FORM_SECONDS, UPLOADS_A_DAY } from '../../packages/backend/uploads.ts';
import type { City, Spot, SpotNames } from '../../packages/backend/places.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { png } from '../../packages/testing/images.ts';
import { fixture, NOW, ORIGIN } from '../oauth/fixtures.ts';

const TODAY = '2026-10-13',
  DAY = Math.floor(NOW / 86400),
  PDF = Buffer.from('%PDF-1.4 synthetic'),
  NAMED: SpotNames = {
    city: 'Minneapolis',
    region: 'Minnesota',
    country: 'United States',
    tz: 'America/Chicago',
    district: 'North Loop',
    nearby: [{ name: 'Corner Coffee', lat: 44.98, lon: -93.27, distance_m: 9 }]
  };

function setup() {
  const objects = new FakeObjects(),
    logs: OAuthRow[] = [],
    spots: Spot[] = [],
    naming = { answer: NAMED as SpotNames | null, fail: false },
    ctx = {
      ...fixture(),
      objects,
      nameSpot: async (spot: Spot) => {
        spots.push(spot);
        if (naming.fail) throw Object.assign(new Error('Location down'), { name: 'ThrottlingException' });
        return naming.answer;
      }
    },
    write = async (token: string, api: string, args: OAuthRow, key: string | null = null) =>
      (await captureNote({ api, token, arguments: args, key, client: 'Changelog' }, ctx, {
        fetchTitle: () => null,
        log: (f) => logs.push(f)
      })) as OAuthRow;
  return { ctx, objects, logs, spots, naming, write };
}
type Setup = ReturnType<typeof setup>;
async function make(ctx: Setup['ctx'], scopes = ['notes:write', 'media:write'], name = 'Changelog') {
  return (await new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now }).make('u', {
    name,
    scopes,
    expiry: 'never'
  })) as OAuthRow & { token: string; id: string };
}
/** Asks for a form and posts the file to it, as a client does. */
async function upload(s: Setup, token: string, type: string, bytes: Buffer, name: string) {
  const form = await s.write(token, 'uploads.start', { name, type, size: bytes.length });
  assert.equal(form.status, 201, JSON.stringify(form));
  const body = form.body as OAuthRow,
    key = String((body.fields as OAuthRow).key);
  await s.objects.put(key, bytes, { type, tags: { outcome: 'pending' } });
  return { upload: String(body.upload), type, name, key };
}
const live = (objects: FakeObjects, key: string) => {
  const last = objects.versions.get(key)?.at(-1);
  return Boolean(last && !last.deleted);
};
const notes = (s: Setup) =>
  s.ctx.store.memory.all().filter((r) => r.pk === 'USER#u' && String(r.sk).startsWith('NOTE#'));
const copies = (s: Setup) => s.objects.calls.filter((c) => c.operation === 'copy').map((c) => c.key);

test('a token signs a form for one file under its own prefix, counted with the web’s uploads', async () => {
  const s = setup(),
    plain = await make(s.ctx, ['notes:write'], 'Plain'),
    files = await make(s.ctx);
  const refused = await s.write(plain.token, 'uploads.start', { name: 'a.png', type: 'image/png', size: 10 });
  assert.equal(refused.error, 'scope_required');
  assert.match(String(refused.message), /Add files ticked/);
  for (const [args, code, field] of [
    [{ name: 'a.exe', type: 'application/x-msdownload', size: 10 }, 'invalid_request', 'type'],
    [{ name: 'a.png', type: 'image/png', size: 0 }, 'invalid_request', 'size'],
    [{ name: 'a.png', type: 'image/png', size: 1.5 }, 'invalid_request', 'size'],
    [{ name: 'a.png', type: 'image/png', size: media.MAX_UPLOAD + 1 }, 'too_large', 'size'],
    [{ name: 7, type: 'image/png', size: 10 }, 'invalid_request', 'name'],
    [{ type: 'image/png', size: 10, extra: true }, 'invalid_request', 'extra']
  ] as const) {
    const r = await s.write(files.token, 'uploads.start', args);
    assert.deepEqual([r.error, r.field], [code, field], JSON.stringify(args));
  }
  assert.equal(s.objects.calls.length, 0, 'no form signed for a refused request');

  const form = await s.write(files.token, 'uploads.start', { name: 'lake.png', type: 'image/png', size: 1234 }),
    body = form.body as OAuthRow;
  assert.equal(form.status, 201);
  assert.match(String(body.upload), /^[0-9a-f]{32}$/);
  assert.equal(body.type, 'image/png');
  assert.equal(body.expires_in, FORM_SECONDS);
  assert.ok(String(body.url).startsWith('https://'));
  // The pending prefix is the token's own, never the web's.
  assert.equal((body.fields as OAuthRow).key, `media/u/api/${String(body.upload)}.png`);
  assert.equal((body.fields as OAuthRow).seconds, String(FORM_SECONDS));
  // A PDF named so, sent as bytes of no particular type, is a PDF, as on the web.
  const named = await s.write(files.token, 'uploads.start', {
    name: 'map.pdf',
    type: 'application/octet-stream',
    size: 99
  });
  assert.equal((named.body as OAuthRow).type, 'application/pdf');

  // One count for the account, the web's and every token's.
  const count = () => s.ctx.store.memory.all().find((r) => r.pk === `RATE#upload:u#${DAY}`);
  assert.deepEqual([count()?.n, count()?.bytes], [2, 1234 + 99]);
  assert.equal(await s.ctx.store.countUpload('u', DAY, 10, UPLOADS_A_DAY, 2 * 1024 ** 3), true);
  assert.equal(count()?.n, 3);
  s.ctx.store.seed({ ...count()!, n: UPLOADS_A_DAY });
  const limited = await s.write(files.token, 'uploads.start', { name: 'a.png', type: 'image/png', size: 10 });
  assert.equal(limited.error, 'rate_limited');
  assert.equal(limited.retry_after, (DAY + 1) * 86400 - NOW);
});

test('a refused form count checks the token again: revoked is said, a lasting race is busy', async () => {
  const s = setup(),
    t = await make(s.ctx),
    count = s.ctx.store.apiUploadCount.bind(s.ctx.store);
  s.ctx.store.apiUploadCount = async () => 'retry';
  const busy = await s.write(t.token, 'uploads.start', { name: 'a.png', type: 'image/png', size: 10 });
  assert.equal(busy.error, 'busy');
  s.ctx.store.apiUploadCount = async (token, ...rest) => {
    await s.ctx.store.revokeToken(token);
    return count(token, ...rest);
  };
  const revoked = await s.write(t.token, 'uploads.start', { name: 'a.png', type: 'image/png', size: 10 });
  assert.equal(revoked.error, 'token_revoked');
  assert.equal(s.objects.calls.length, 0);
});

test('a note takes uploaded files: checked, copied, numbered, and the pending file removed once it has them', async () => {
  const s = setup(),
    t = await make(s.ctx),
    photo = await upload(s, t.token, 'image/png', png(), 'lake.png'),
    map = await upload(s, t.token, 'application/pdf', PDF, 'map.pdf'),
    uploads = [photo, map].map(({ upload, type, name }) => ({ upload, type, name }));
  const made = await s.write(t.token, 'notes.create', { uploads }, 'k1'),
    note = (made.body as OAuthRow).note as OAuthRow;
  assert.equal(made.status, 201, JSON.stringify(made));
  assert.equal(note.files, 2);
  const [row] = notes(s);
  assert.equal(row!.text, '');
  assert.equal(row!.source, 'api');
  const entries = row!.media as OAuthRow[];
  assert.deepEqual(
    entries.map(({ key, ...rest }) => (assert.match(String(key), /^media\/u\/files\/[0-9a-f]{32}\./), rest)),
    [
      { n: 1, kind: 'image', type: 'image/png', size: png().length, name: 'lake.png', width: 640, height: 480 },
      { n: 2, kind: 'file', type: 'application/pdf', size: PDF.length, name: 'map.pdf' }
    ]
  );
  // The copies are kept tagged note; the pending files are gone.
  for (const e of entries) {
    assert.ok(live(s.objects, String(e.key)));
    assert.deepEqual(s.objects.versions.get(String(e.key))!.at(-1)!.tags, { outcome: 'note' });
  }
  for (const p of [photo, map]) assert.deepEqual(s.objects.versions.get(p.key), []);
  const added = s.ctx.store.memory.all().find((r) => r.kind === 'note.added')!;
  assert.deepEqual([added.via, added.token, added.files], ['token', 'Changelog', 2]);
  const audit = s.ctx.store.memory.all().find((r) => r.tool === 'v1:notes.create')!;
  assert.equal(audit.files, 2);

  // The same key answers again without touching a file; the same uploads in
  // another note are refused, since the first note took them.
  const copied = copies(s).length,
    again = await s.write(t.token, 'notes.create', { uploads }, 'k1');
  assert.equal(again.replayed, true);
  assert.equal(copies(s).length, copied);
  const twice = await s.write(t.token, 'notes.create', { uploads: [uploads[0]] }, 'k2');
  assert.deepEqual([twice.error, twice.field], ['invalid_request', 'uploads']);
  assert.equal(notes(s).length, 1);

  // Words and files together; a note of neither is refused.
  const more = await upload(s, t.token, 'image/png', png(), 'dock.png'),
    both = await s.write(t.token, 'notes.create', {
      text: 'Dock #lake',
      uploads: [{ upload: more.upload, type: more.type }]
    });
  assert.equal(both.status, 201);
  const empty = await s.write(t.token, 'notes.create', { text: '  ' });
  assert.equal(empty.error, 'text_required');
  const none = await s.write(t.token, 'notes.create', { uploads: [] });
  assert.deepEqual([none.error, none.field], ['invalid_request', 'uploads']);
});

test('files need media:write, the token’s own prefix, and bytes that match their form', async () => {
  const s = setup(),
    plain = await make(s.ctx, ['notes:write'], 'Plain'),
    t = await make(s.ctx),
    photo = await upload(s, t.token, 'image/png', png(), 'lake.png');
  const before = s.objects.calls.length;
  const refused = await s.write(plain.token, 'notes.create', { uploads: [{ upload: photo.upload, type: photo.type }] });
  assert.equal(refused.error, 'scope_required');
  assert.match(String(refused.message), /Add files ticked/);
  assert.equal(s.objects.calls.length, before, 'nothing read for a token without media:write');

  const id = 'a'.repeat(32),
    put = (key: string, bytes: Buffer, tags: Record<string, string> = { outcome: 'pending' }) =>
      s.objects.put(key, bytes, { type: 'image/png', tags });
  // A file sent from the web is under media/<user>/web/, out of a token's reach.
  await put(media.uploadKey('u', id, 'image/png'), png());
  // Bytes that are not what the form said, or that are not pending.
  await put(media.uploadKey('u', 'b'.repeat(32), 'image/png', 'api'), Buffer.from('not a picture'));
  await put(media.uploadKey('u', 'c'.repeat(32), 'image/png', 'api'), png(), { outcome: 'note' });
  for (const upload of [id, 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(32), 'nope']) {
    const r = await s.write(t.token, 'notes.create', { text: 'Lake', uploads: [{ upload, type: 'image/png' }] });
    assert.deepEqual([r.error, r.field], ['invalid_request', 'uploads'], upload);
  }
  const twice = await s.write(t.token, 'notes.create', {
    uploads: [
      { upload: photo.upload, type: photo.type },
      { upload: photo.upload, type: photo.type }
    ]
  });
  assert.deepEqual([twice.error, twice.field], ['invalid_request', 'uploads']);
  assert.equal(notes(s).length, 0);
  assert.deepEqual(copies(s), []);
  assert.ok(live(s.objects, photo.key), 'a refused note leaves the upload for another try');
});

test('files added to a token’s own note go after the ones it has, and count as a change', async () => {
  const s = setup(),
    t = await make(s.ctx),
    made = await s.write(t.token, 'notes.create', { text: 'Lake day https://example.com/a' }),
    ref = (made.body as OAuthRow).note as OAuthRow,
    first = await upload(s, t.token, 'image/png', png(), 'one.png');
  const [old] = notes(s);
  const one = await s.write(t.token, 'notes.media', {
    date: ref.date,
    id: ref.id,
    uploads: [{ upload: first.upload, type: first.type }]
  });
  assert.equal(one.status, 200, JSON.stringify(one));
  assert.equal(((one.body as OAuthRow).note as OAuthRow).files, 1);
  const second = await upload(s, t.token, 'application/pdf', PDF, 'two.pdf'),
    two = await s.write(t.token, 'notes.media', {
      date: ref.date,
      id: ref.id,
      uploads: [{ upload: second.upload, type: second.type, name: 'two.pdf' }]
    });
  assert.equal(two.status, 200, JSON.stringify(two));
  const [row] = notes(s);
  assert.deepEqual(
    (row!.media as OAuthRow[]).map((m) => [m.n, m.kind]),
    [
      [1, 'image'],
      [2, 'file']
    ]
  );
  // The words and their link titles are as they were; the revision moved.
  assert.equal(row!.text, old!.text);
  assert.deepEqual(row!.links, old!.links);
  assert.equal(row!.revision, 3);
  assert.ok(row!.updated_at);
  const filed = s.ctx.store.memory.all().filter((r) => r.kind === 'note.files');
  assert.deepEqual(
    filed.map((r) => [r.via, r.token, r.added, r.note]),
    [
      ['token', 'Changelog', 1, ref.id],
      ['token', 'Changelog', 1, ref.id]
    ]
  );
  const change = s.ctx.store.memory.all().find((r) => r.sk === `WRITERATE#v1-change#${DAY}`)!;
  assert.equal(change.n, 2);

  // Only the token's own note, and never past twenty files.
  s.ctx.store.seed({ pk: 'USER#u', sk: `NOTE#${TODAY}#w-web`, text: 'From the web', source: 'web', revision: 1 });
  const third = await upload(s, t.token, 'image/png', png(), 'three.png'),
    uploads = [{ upload: third.upload, type: third.type }];
  const theirs = await s.write(t.token, 'notes.media', { date: TODAY, id: 'w-web', uploads });
  assert.equal(theirs.error, 'not_yours');
  // Reaching all the notes adds files to any of them (1.11.0).
  const all = await make(s.ctx, ['notes:write', 'media:write', 'notes:all'], 'All'),
    fourth = await upload(s, all.token, 'image/png', png(), 'four.png'),
    reached = await s.write(all.token, 'notes.media', {
      date: TODAY,
      id: 'w-web',
      uploads: [{ upload: fourth.upload, type: fourth.type }]
    });
  assert.equal(reached.status, 200, JSON.stringify(reached));
  const web = await s.ctx.store.note('u', TODAY, 'w-web', true);
  assert.deepEqual([web!.source, (web!.media as OAuthRow[]).length, web!.text], ['web', 1, 'From the web']);
  s.ctx.store.seed({
    ...row!,
    media: Array.from({ length: media.MAX_FILES }, (_, i) => ({ ...(row!.media as OAuthRow[])[0], n: i + 1 }))
  });
  const full = await s.write(t.token, 'notes.media', { date: ref.date, id: ref.id, uploads });
  assert.deepEqual([full.error, full.field], ['invalid_request', 'uploads']);
  assert.match(String(full.message), /20 files/);
  const plain = await make(s.ctx, ['notes:write'], 'Plain'),
    narrow = await s.write(plain.token, 'notes.media', { date: ref.date, id: ref.id, uploads });
  assert.equal(narrow.error, 'scope_required');
  assert.ok(live(s.objects, third.key));
});

test('copies no note took are removed and the pending files kept for a retry', async () => {
  const s = setup(),
    t = await make(s.ctx),
    photo = await upload(s, t.token, 'image/png', png(), 'lake.png'),
    uploads = [{ upload: photo.upload, type: photo.type }],
    commit = s.ctx.store.apiNoteCommit.bind(s.ctx.store);
  // A commit that never lands: checked and copied once, then the copy goes.
  s.ctx.store.apiNoteCommit = async () => false;
  const busy = await s.write(t.token, 'notes.create', { uploads }, 'k');
  assert.equal(busy.error, 'busy');
  assert.equal(copies(s).length, 1);
  assert.ok(!live(s.objects, copies(s)[0]!));
  assert.ok(live(s.objects, photo.key));
  // A commit that throws before it wrote: no receipt, so the copy goes.
  s.ctx.store.apiNoteCommit = async () => {
    throw Object.assign(new Error('Network'), { name: 'TimeoutError' });
  };
  const thrown = await s.write(t.token, 'notes.create', { uploads }, 'k');
  assert.equal(thrown.error, 'unavailable');
  assert.ok(!live(s.objects, copies(s)[1]!));
  assert.ok(live(s.objects, photo.key));
  // A commit that wrote but lost its answer: the receipt says so, and the
  // copy stays with its note. The retry answers from the receipt.
  s.ctx.store.apiNoteCommit = async (...a) => {
    await commit(...a);
    throw Object.assign(new Error('Network'), { name: 'TimeoutError' });
  };
  const lost = await s.write(t.token, 'notes.create', { uploads }, 'k');
  assert.equal(lost.error, 'unavailable');
  const kept = copies(s)[2]!;
  assert.ok(live(s.objects, kept));
  assert.equal(String((notes(s)[0]!.media as OAuthRow[])[0]!.key), kept);
  s.ctx.store.apiNoteCommit = commit;
  const retried = await s.write(t.token, 'notes.create', { uploads }, 'k');
  assert.equal(retried.replayed, true);
  assert.equal(copies(s).length, 3);
});

test('deleting a token’s note removes its files and their thumbnails', async () => {
  const s = setup(),
    t = await make(s.ctx),
    photo = await upload(s, t.token, 'image/png', png(), 'lake.png'),
    made = await s.write(t.token, 'notes.create', { uploads: [{ upload: photo.upload, type: photo.type }] }),
    ref = (made.body as OAuthRow).note as OAuthRow,
    key = String((notes(s)[0]!.media as OAuthRow[])[0]!.key),
    thumb = media.thumbKey(key);
  // The thumbnail the stream reader makes beside it.
  await s.objects.put(thumb, Buffer.from('thumb'), { type: 'image/jpeg' });
  const gone = await s.write(t.token, 'notes.delete', { date: ref.date, id: ref.id });
  assert.equal(gone.status, 204);
  assert.ok(!live(s.objects, key));
  assert.ok(!live(s.objects, thumb));
  assert.equal(s.ctx.store.memory.all().find((r) => r.kind === 'note.deleted')!.files, 1);
});

test('Here names a device’s spot as the web does, and a note keeps that place or a city', async () => {
  const s = setup(),
    t = await make(s.ctx, ['notes:write']),
    spot = { lat: 44.9877531, lon: -93.2650119, accuracy_m: 12.4 };
  const here = await s.write(t.token, 'places.here', spot);
  assert.equal(here.status, 200, JSON.stringify(here));
  const place = (here.body as OAuthRow).place as OAuthRow;
  assert.deepEqual(here.body, {
    place: {
      name: 'Minneapolis',
      region: 'Minnesota',
      country: 'United States',
      tz: 'America/Chicago',
      district: 'North Loop',
      lat: 44.987753,
      lon: -93.265012,
      accuracy_m: 12,
      from: 'device'
    },
    nearby: NAMED.nearby
  });
  assert.deepEqual(s.spots, [{ lat: 44.987753, lon: -93.265012, accuracy_m: 12 }]);
  assert.deepEqual(here.limit, {
    limit: V1_LIMITS.here,
    remaining: V1_LIMITS.here - 1,
    reset: (DAY + 1) * 86400 - NOW
  });
  assert.equal(here.replayed, false);

  // The place goes back with the note, named by a business nearby if chosen.
  const atCafe = await s.write(t.token, 'notes.create', {
    text: 'Coffee',
    place: { ...place, venue: 'Corner Coffee' }
  });
  assert.equal(atCafe.status, 201, JSON.stringify(atCafe));
  const paris = {
      name: 'Paris',
      region: 'Ile-de-France',
      country: 'France',
      tz: 'Europe/Paris',
      lat: 48.85,
      lon: 2.35
    },
    inParis = await s.write(t.token, 'notes.create', { text: 'Bonjour', place: paris });
  assert.equal(inParis.status, 201, JSON.stringify(inParis));
  const byText = (text: string) => notes(s).find((n) => n.text === text)!.place;
  assert.deepEqual(byText('Coffee'), {
    city: 'Minneapolis',
    region: 'Minnesota',
    country: 'United States',
    district: 'North Loop',
    venue: 'Corner Coffee',
    tz: 'America/Chicago',
    lat: 44.987753,
    lon: -93.265012,
    accuracy_m: 12,
    from: 'device'
  });
  assert.deepEqual(byText('Bonjour'), {
    city: 'Paris',
    region: 'Ile-de-France',
    country: 'France',
    tz: 'Europe/Paris',
    lat: 48.85,
    lon: 2.35,
    from: 'chosen'
  });
  for (const bad of [{ name: 'Nowhere' }, { ...place, lat: 91 }, 'Paris'])
    assert.deepEqual(((r) => [r.error, r.field])(await s.write(t.token, 'notes.create', { text: 'x', place: bad })), [
      'invalid_request',
      'place'
    ]);

  // A spot that is not one; a spot with no city; naming that fails, logged
  // without the spot.
  for (const bad of [{ lat: 95, lon: 0 }, { lat: 1 }, { lat: 1, lon: 2, accuracy_m: -1 }, { lat: '1', lon: 2 }])
    assert.equal((await s.write(t.token, 'places.here', bad)).error, 'invalid_request', JSON.stringify(bad));
  s.naming.answer = null;
  assert.equal((await s.write(t.token, 'places.here', spot)).error, 'not_found');
  s.naming.fail = true;
  assert.equal((await s.write(t.token, 'places.here', spot)).error, 'unavailable');
  const logged = JSON.stringify(s.logs);
  assert.ok(logged.includes('here-error'));
  assert.ok(!logged.includes('44.98') && !logged.includes('93.26'), 'no coordinates in the log');

  // Each spot named is counted, a day per account.
  const count = s.ctx.store.memory.all().find((r) => r.sk === `WRITERATE#v1-here#${DAY}`)!;
  assert.equal(count.n, 3);
  s.ctx.store.seed({ ...count, n: V1_LIMITS.here });
  const limited = await s.write(t.token, 'places.here', spot);
  assert.equal(limited.error, 'rate_limited');
  assert.equal(limited.retry_after, (DAY + 1) * 86400 - NOW);
  const reader = await make(s.ctx, ['activity'], 'Reader');
  assert.equal((await s.write(reader.token, 'places.here', spot)).error, 'scope_required');
});

test('the routes reach files and Here through capture, and the router answers the city search', async () => {
  const s = setup(),
    asked: string[] = [],
    PARIS: City[] = [
      { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 },
      { name: 'Paris', region: 'Texas', country: 'United States', tz: 'America/Chicago', lat: 33.66, lon: -95.56 }
    ],
    ctx = Object.assign(s.ctx, {
      geocode: async (q: string) => {
        asked.push(q);
        if (q === 'down') throw new Error('Search down');
        return q.toLowerCase() === 'paris' ? PARIS : [];
      }
    }),
    app = createMcpApp({
      context: () => ctx,
      capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: () => {} }),
      log: () => {}
    }),
    t = await make(ctx),
    plain = await make(ctx, ['notes:write'], 'Plain'),
    dates = await make(ctx, ['upcoming'], 'Dates'),
    call = async (method: string, path: string, token: string, body?: unknown, accept?: string) => {
      const r = await app.request(ORIGIN + path, {
          method,
          headers: {
            authorization: 'Bearer ' + token,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(accept ? { accept } : {})
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }),
        text = await r.text();
      let json: OAuthRow = {};
      try {
        json = JSON.parse(text) as OAuthRow;
      } catch {
        /* A line of text. */
      }
      return { r, status: r.status, text, json, error: (json.error ?? {}) as OAuthRow };
    };

  // A form, from the route: the capture function signs it.
  const bytes = png(),
    started = await call('POST', '/v1/uploads', t.token, { name: 'lake.png', type: 'image/png', size: bytes.length });
  assert.equal(started.status, 201, started.text);
  assert.equal(started.r.headers.get('api-version'), API_VERSION);
  assert.deepEqual(Object.keys(started.json).sort(), ['expires_in', 'fields', 'type', 'upload', 'url']);
  assert.equal(started.json.expires_in, FORM_SECONDS);
  const key = String((started.json.fields as OAuthRow).key);
  assert.ok(key.startsWith('media/u/api/'), key);
  await s.objects.put(key, bytes, { type: 'image/png', tags: { outcome: 'pending' } });
  const line = await call('POST', '/v1/uploads', t.token, { type: 'image/png', size: 9 }, 'text/plain');
  assert.match(line.text, /^Upload [0-9a-f]{32}\. Its form's url and fields come in the JSON answer\.\n$/);
  const refused = await call('POST', '/v1/uploads', plain.token, { type: 'image/png', size: 9 });
  assert.deepEqual(
    [refused.status, refused.error.code, refused.error.message],
    [403, 'scope_required', SCOPE_REFUSALS['media:write']]
  );

  // A note takes it, then a second file through the media route.
  const created = await call('POST', '/v1/notes', t.token, {
    uploads: [{ upload: started.json.upload, type: 'image/png', name: 'lake.png' }]
  });
  assert.equal(created.status, 201, created.text);
  const note = created.json.note as OAuthRow;
  assert.equal(note.files, 1);
  const second = await upload(s, t.token, 'application/pdf', PDF, 'map.pdf'),
    path = `/v1/notes/${String(note.date)}/${String(note.id)}/media`,
    added = await call('POST', path, t.token, { uploads: [second] }, 'text/plain');
  assert.equal(added.status, 200, added.text);
  assert.equal(added.text, `Changed in ${String(note.version)}.\n`);
  assert.equal((notes(s)[0]!.media as unknown[]).length, 2);
  // A token without files is refused at the router; the route takes POST alone.
  const other = await call('POST', path, plain.token, { uploads: [second] });
  assert.equal(other.error.code, 'scope_required');
  assert.equal((await call('GET', path, t.token)).status, 405);

  // The city search, answered by the router with any token that may add notes.
  const found = await call('GET', '/v1/places?q=%20Paris%20', plain.token);
  assert.equal(found.status, 200, found.text);
  assert.deepEqual(found.json, { places: PARIS });
  assert.deepEqual(asked, ['Paris']);
  assert.equal(
    (await call('GET', '/v1/places?q=paris', plain.token, undefined, 'text/plain')).text,
    'Paris, Ile-de-France, France\nParis, Texas, United States\n'
  );
  assert.equal(
    (await call('GET', '/v1/places?q=Nowhere', plain.token, undefined, 'text/plain')).text,
    'No city by that name.\n'
  );
  for (const q of ['', 'P', 'x'.repeat(81)]) {
    const bad = await call('GET', '/v1/places?q=' + q, plain.token);
    assert.deepEqual([bad.status, bad.error.code, bad.error.field], [400, 'invalid_request', 'q'], q);
  }
  assert.deepEqual(asked.length, 3, 'a refused query is never searched');
  const down = await call('GET', '/v1/places?q=down', plain.token);
  assert.deepEqual([down.status, down.error.code], [503, 'unavailable']);
  assert.equal((await call('GET', '/v1/places?q=Paris', dates.token)).error.code, 'scope_required');

  // Here, through capture, with its count in the headers and its line.
  const spot = { lat: 44.9877531, lon: -93.2650119, accuracy_m: 12.4 },
    here = await call('POST', '/v1/places/here', plain.token, spot);
  assert.equal(here.status, 200, here.text);
  assert.equal((here.json.place as OAuthRow).district, 'North Loop');
  assert.deepEqual(here.json.nearby, NAMED.nearby);
  assert.equal(here.r.headers.get('ratelimit-limit'), String(V1_LIMITS.here));
  assert.equal(here.r.headers.get('ratelimit-remaining'), String(V1_LIMITS.here - 1));
  assert.equal(
    (await call('POST', '/v1/places/here', plain.token, spot, 'text/plain')).text,
    'North Loop, Minneapolis, Minnesota, United States. Nearby: Corner Coffee.\n'
  );
  const badSpot = await call('POST', '/v1/places/here', plain.token, { lat: 95, lon: 0 });
  assert.deepEqual([badSpot.status, badSpot.error.code, badSpot.error.field], [400, 'invalid_request', 'lat']);
  assert.equal((await call('POST', '/v1/places/here', dates.token, spot)).error.code, 'scope_required');
  assert.equal((await call('GET', '/v1/places/here', plain.token)).status, 405);
});
