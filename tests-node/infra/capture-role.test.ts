/** The capture function's role allows every DynamoDB request its write tools
 * make. A missing grant (Query, for Upcoming writes, 2026-10-17) only showed up
 * live, as `temporarily_unavailable`. Each tool runs against the fake table and
 * every recorded request is held to the role (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureNote } from '../../workers/capture.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { fixture, connected } from '../oauth/fixtures.ts';
import { Recorder } from './grants.ts';

type Input = Record<string, unknown>;
test('the capture role grants every DynamoDB request the write tools make', async () => {
  const aws = new Recorder('CaptureFunction'),
    ctx = fixture(),
    a = await connected(ctx, true, true, 'u', true),
    run = (tool: string, args: Input) =>
      captureNote(
        { token: a.token, tool, arguments: args },
        { ...ctx, geocode: async () => [] },
        { fetchTitle: () => null }
      );
  aws.watch(ctx.store);
  const created = await run('notes_create', { date: '2026-10-07', text: 'Dinner', idempotency_key: 'c' });
  const shown = created.note as OAuthRow;
  assert.ok(shown, JSON.stringify(created));
  const appended = await run('notes_append', { date: shown.date, id: shown.id, text: 'Walk', idempotency_key: 'a' });
  assert.ok(appended.note, JSON.stringify(appended));
  // A replayed key answers from its receipt.
  const replayed = await run('notes_append', { date: shown.date, id: shown.id, text: 'Walk', idempotency_key: 'a' });
  assert.equal(replayed.replayed, true, JSON.stringify(replayed));
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

  const made = aws.granted();
  assert.ok(made.some((r) => r.action === 'dynamodb:Query'));
  assert.ok(made.some((r) => r.via === 'TransactWriteCommand ConditionCheck'));
  assert.deepEqual(aws.unused(), [], 'every grant is used');
});
