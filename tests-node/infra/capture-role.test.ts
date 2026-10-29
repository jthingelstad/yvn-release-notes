/** The capture function's role allows every DynamoDB request its write tools
 * make, and the one S3 put feedback screenshots need. A missing grant (Query, for Upcoming writes, 2026-10-17) only showed up
 * live, as `temporarily_unavailable`. Each tool runs against the fake table and
 * every recorded request is held to the role (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureNote } from '../../workers/capture.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { fixture, connected } from '../oauth/fixtures.ts';
import { b64, png } from '../../packages/testing/images.ts';
import { Recorder } from './grants.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { testImage } from '../../packages/backend/describe.ts';

type Input = Record<string, unknown>;
test('the capture role grants every DynamoDB and S3 request the write tools make', async () => {
  const aws = new Recorder('CaptureFunction'),
    ctx = fixture(),
    a = await connected(ctx, true, true, 'u', true, true),
    objects = aws.objects(new FakeObjects()),
    run = (tool: string, args: Input) =>
      captureNote(
        { token: a.token, tool, arguments: args },
        { ...ctx, objects, geocode: async () => [] },
        { fetchTitle: () => null }
      ),
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

  const made = aws.granted();
  assert.ok(made.some((r) => r.action === 'dynamodb:Query'));
  assert.ok(made.some((r) => r.via === 'TransactWriteCommand ConditionCheck'));
  assert.deepEqual(aws.unused(), [], 'every grant is used');
});
