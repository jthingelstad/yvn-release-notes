/** The capture function's role allows every DynamoDB request its write tools
 * and `/v1`'s writes make, and the S3 and Location requests their files and
 * Here need. A missing grant (Query, for Upcoming writes, 2026-10-17) only
 * showed up live, as `temporarily_unavailable`. Each tool and `/v1` write
 * runs against the fake table and bucket, and every recorded request is held
 * to the role (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureNote } from '../../workers/capture.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { fixture, connected } from '../oauth/fixtures.ts';
import { b64, png } from '../../packages/testing/images.ts';
import { Recorder, REGION } from './grants.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { testImage } from '../../packages/backend/describe.ts';
import { nameSpot } from '../../packages/backend/places.ts';
import { Tokens } from '../../packages/backend/tokens.ts';

type Input = Record<string, unknown>;
test('the capture role grants every DynamoDB and S3 request the write tools make', async () => {
  const aws = new Recorder('CaptureFunction'),
    ctx = fixture(),
    a = await connected(ctx, true, true, 'u', true, true),
    bucket = new FakeObjects(),
    objects = aws.objects(bucket),
    context = {
      ...ctx,
      objects,
      geocode: async () => [],
      // Naming a device's spot, the real adapter as IAM authorizes it.
      nameSpot: (spot: { lat: number; lon: number }) =>
        nameSpot(spot, {
          async send() {
            aws.add('places.nameSpot', 'geo-places:ReverseGeocode', `arn:aws:geo-places:${REGION}::provider/default`);
            return { ResultItems: [{ Address: { Locality: 'Paris', Country: { Code2: 'FR', Name: 'France' } } }] };
          }
        } as never)
    },
    run = (tool: string, args: Input) =>
      captureNote({ token: a.token, tool, arguments: args }, context, { fetchTitle: () => null }),
    photo = [{ name: 'p.png', type: 'image/png', data: testImage().toString('base64') }];
  aws.watch(ctx.store);
  const created = await run('notes_create', { date: '2026-10-07', text: 'Dinner', idempotency_key: 'c' });
  const shown = created.note as OAuthRow;
  assert.ok(shown, JSON.stringify(created));
  const appended = await run('notes_append', { date: shown.date, id: shown.id, text: 'Walk', idempotency_key: 'a' });
  assert.ok(appended.note, JSON.stringify(appended));
  // A replayed key answers from its receipt.
  const replayed = await run('notes_append', { date: shown.date, id: shown.id, text: 'Walk', idempotency_key: 'a' });
  assert.equal(replayed.replayed, true, JSON.stringify(replayed));
  // Files are kept tagged (PutObject, PutObjectTagging) on create and attach,
  // and removed (DeleteObject) when the write cannot commit.
  const withFile = await run('notes_create', { text: 'Photo', files: photo, idempotency_key: 'f' });
  assert.ok(withFile.note, JSON.stringify(withFile));
  const attached = await run('notes_attach', { date: shown.date, id: shown.id, files: photo, idempotency_key: 't' });
  assert.ok(attached.note, JSON.stringify(attached));
  const edited = await run('notes_edit', {
    date: shown.date,
    id: shown.id,
    text: 'Dinner and a walk',
    revision: (attached.note as OAuthRow).revision,
    idempotency_key: 'e'
  });
  assert.ok(edited.note, JSON.stringify(edited));
  const commit = ctx.store.captureCommit.bind(ctx.store);
  ctx.store.captureCommit = async () => false;
  const lost = await run('notes_create', { text: 'Lost', files: photo, idempotency_key: 'l' });
  assert.ok(lost.error, JSON.stringify(lost));
  ctx.store.captureCommit = commit;
  const draft = { kind: 'anniversary', title: 'Work', date: '01-06', year: 2020, reminders: [7, 1, 0] };
  const dry = await run('upcoming_save', { entries: [draft], idempotency_key: 'd', dry_run: true });
  assert.equal(dry.dry_run, true, JSON.stringify(dry));
  const saved = await run('upcoming_save', { entries: [draft], idempotency_key: 's' });
  const entry = (saved.saved as OAuthRow[] | undefined)?.[0];
  assert.ok(entry, JSON.stringify(saved));
  const removed = await run('upcoming_delete', {
    entries: [{ id: entry.id, revision: entry.revision }],
    idempotency_key: 'r'
  });
  assert.equal(removed.removed, 1, JSON.stringify(removed));
  // Feedback with a screenshot, put under the owner's media.
  const sent = await run('notes_send_feedback', {
    kind: 'idea',
    text: 'Words',
    screenshots: [{ type: 'image/png', data: b64(png()) }],
    idempotency_key: 'fb'
  });
  assert.equal(sent.replayed, false, JSON.stringify(sent));

  // A token's writes (`/v1`, workers/api-writes.ts). The token is made on
  // the web, outside this role.
  const token = String(
      (
        await aws.aside(ctx.store, null, () =>
          new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now }).make('u', {
            name: 'Changelog',
            scopes: ['notes:write', 'media:write', 'upcoming'],
            expiry: 'never'
          })
        )
      ).token
    ),
    api = async (op: string, args: Input, key: string | null = null) =>
      (await captureNote({ api: op, token, arguments: args, key }, context, { fetchTitle: () => null })) as OAuthRow,
    // A form signed (PutObject and PutObjectTagging, as the role), and the
    // file posted to it by the client, outside the role.
    upload = async () => {
      const form = await api('uploads.start', { name: 'p.png', type: 'image/png', size: testImage().length }),
        body = form.body as OAuthRow;
      assert.equal(form.status, 201, JSON.stringify(form));
      await bucket.put(String((body.fields as OAuthRow).key), testImage(), {
        type: 'image/png',
        tags: { outcome: 'pending' }
      });
      return [{ upload: body.upload, type: 'image/png' }];
    };
  // A note that takes an upload: its first bytes, that version's tags and
  // size, the copy to files/, then the pending version deleted.
  const lake = { text: 'Lake', uploads: await upload() },
    tokenNote = await api('notes.create', lake, 'v1');
  assert.equal(tokenNote.status, 201, JSON.stringify(tokenNote));
  const ref = (tokenNote.body as OAuthRow).note as OAuthRow,
    at = { date: ref.date, id: ref.id };
  assert.equal((await api('notes.create', lake, 'v1')).replayed, true);
  assert.equal((await api('notes.media', { ...at, uploads: await upload() })).status, 200);
  // An upload that never arrived reads as missing only with ListBucket.
  const never = await api('notes.media', { ...at, uploads: [{ upload: 'f'.repeat(32), type: 'image/png' }] });
  assert.equal(never.field, 'uploads', JSON.stringify(never));
  const appendedV1 = await api('notes.append', { ...at, text: 'Swim' });
  assert.equal(appendedV1.status, 200, JSON.stringify(appendedV1));
  const editedV1 = await api('notes.edit', {
    ...at,
    text: 'Lake and a swim',
    revision: ((appendedV1.body as OAuthRow).note as OAuthRow).revision
  });
  assert.equal(editedV1.status, 200, JSON.stringify(editedV1));
  assert.equal((await api('places.here', { lat: 48.856613, lon: 2.352222, accuracy_m: 12 })).status, 200);
  assert.equal((await api('tags.pinned', { pinned: ['lake'] })).status, 200);
  const dates = await api('upcoming.batch', { add: [draft] });
  assert.equal(dates.status, 200, JSON.stringify(dates));
  const date = ((dates.body as OAuthRow).added as OAuthRow[])[0]!;
  assert.equal((await api('upcoming.delete', { id: date.id, revision: date.revision })).status, 204);
  // Deleting the note deletes its kept files.
  assert.equal((await api('notes.delete', at)).status, 204);
  // A token that reaches all the notes (1.11.0) adds files to an emailed
  // note, then deletes it with the email behind it and every file, as the
  // web's delete does.
  const all = String(
      (
        await aws.aside(ctx.store, null, () =>
          new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now }).make('u', {
            name: 'Everything',
            scopes: ['notes:write', 'media:write', 'notes:all'],
            expiry: 'never'
          })
        )
      ).token
    ),
    emailed = { date: '2026-10-13', id: 'e-mail' },
    emailedPhoto = 'media/u/2026-10-13/e-mail/1.jpg';
  ctx.store.seed({
    pk: 'USER#u',
    sk: 'NOTE#2026-10-13#e-mail',
    text: 'By email',
    source: 'email',
    raw_key: 'raw/m-1',
    written_at: '2026-10-13T12:00:00Z',
    media: [{ n: 1, kind: 'image', type: 'image/jpeg', key: emailedPhoto, size: 3 }]
  });
  for (const key of ['raw/m-1', emailedPhoto, 'media/u/2026-10-13/e-mail/1.thumb.jpg'])
    await bucket.put(key, Buffer.from('abc'), { type: 'application/octet-stream' });
  const everything = async (op: string, args: Input) =>
    (await captureNote({ api: op, token: all, arguments: args, key: null }, context, {
      fetchTitle: () => null
    })) as OAuthRow;
  const filed = await everything('notes.media', { ...emailed, uploads: await upload() });
  assert.equal(filed.status, 200, JSON.stringify(filed));
  assert.equal((await everything('notes.delete', emailed)).status, 204);
  const gone = bucket.calls.filter((c) => c.operation === 'remove' && !c.version).map((c) => c.key);
  for (const key of ['raw/m-1', emailedPhoto, 'media/u/2026-10-13/e-mail/1.thumb.jpg'])
    assert.ok(gone.includes(key), key);
  assert.equal((await api('token.revoke', {})).status, 204);

  const made = aws.granted();
  assert.ok(made.some((r) => r.action === 'dynamodb:Query'));
  assert.ok(made.some((r) => r.via === 'TransactWriteCommand ConditionCheck'));
  assert.deepEqual(aws.unused(), [], 'every grant is used');
});
