/** The MCP server's role grants what every tool requests: the bearer check,
 * the quota, each read tool, photo and recording bytes and signed links, and
 * the capture invocation for writes (whose own requests are the capture
 * role's, held to it as well) (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp, type McpOptions } from '../../server/mcp/app.ts';
import type { MediaReader } from '../../server/mcp/reader.ts';
import { captureNote } from '../../workers/capture.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { fixture, connected, note, ORIGIN } from '../oauth/fixtures.ts';
import { Recorder, functionArn, REGION, ACCOUNT, STACK } from './grants.ts';

test('the MCP role grants every request each tool makes', async () => {
  const aws = new Recorder('NativeMcpRevision'),
    capture = new Recorder('CaptureFunction'),
    ctx = fixture(),
    // Connecting is the web app's OAuth, under its own role.
    a = await connected(ctx, true, true, 'u', true),
    bucket = `arn:aws:s3:::${aws.env.MAIL_BUCKET}`,
    // As server/mcp/index.ts: a signed GetObject link, or a ranged GetObject.
    media: MediaReader = {
      async download(uid, key) {
        assert.ok(key.startsWith(`media/${uid}/`));
        aws.add('media.download', 's3:GetObject', `${bucket}/${key}`);
        return 'https://private.example/signed';
      },
      async bytes(uid, key) {
        assert.ok(key.startsWith(`media/${uid}/`));
        aws.add('media.bytes', 's3:GetObject', `${bucket}/${key}`);
        return Buffer.from('fixture');
      }
    },
    options: McpOptions = {
      context: () => ({ ...ctx, media }),
      capture: (event) => {
        aws.add('capture', 'lambda:InvokeFunction', functionArn(aws.env.CAPTURE_FUNCTION!));
        return aws.aside(ctx.store, capture, () => captureNote(event, ctx, { fetchTitle: () => null }));
      },
      log: () => undefined
    },
    call = async (name: string, args: OAuthRow = {}) => {
      const response = await handleMcp(
          new Request(ORIGIN + '/mcp', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
          }),
          options
        ),
        body = (await response.json()) as { result: { structuredContent: OAuthRow; isError?: boolean } };
      assert.ok(!body.result.isError, `${name}: ${JSON.stringify(body.result.structuredContent)}`);
      return body.result.structuredContent;
    };
  note(ctx, 'media', 'Files #made', '2026-10-07', {
    media: [
      { n: 1, kind: 'image', type: 'image/jpeg', key: 'media/u/original', thumb: { key: 'media/u/thumb' }, size: 7 },
      { n: 2, kind: 'audio', type: 'audio/mp4', key: 'media/u/audio', transcript: 'Words', size: 7 }
    ]
  });
  aws.watch(ctx.store);

  await call('notes_context');
  await call('notes_list');
  await call('notes_search', { q: 'Files' });
  await call('notes_get_day', { date: '2026-10-07' });
  await call('notes_get_note', { date: '2026-10-07', id: 'media' });
  await call('notes_tags');
  await call('notes_view_photo', { date: '2026-10-07', id: 'media', n: 1 });
  await call('notes_view_photo', { date: '2026-10-07', id: 'media', n: 1, original: true });
  await call('notes_get_audio', { date: '2026-10-07', id: 'media', n: 2, inline: true });
  await call('notes_get_audio', { date: '2026-10-07', id: 'media', n: 2 });
  const created = (await call('notes_create', { date: '2026-10-08', text: 'Dinner', idempotency_key: 'c' }))
    .note as OAuthRow;
  await call('notes_append', { date: '2026-10-08', id: created.id, text: 'Walk', idempotency_key: 'a' });
  const entry = { kind: 'anniversary', title: 'Work', date: '01-06', year: 2020, reminders: [7, 1, 0] },
    saved = ((await call('upcoming_save', { entries: [entry], idempotency_key: 's' })).saved as OAuthRow[])[0]!;
  await call('upcoming_list');
  await call('upcoming_delete', { entries: [{ id: saved.id, revision: saved.revision }], idempotency_key: 'r' });

  const made = aws.granted(),
    actions = new Set(made.map((r) => r.action));
  for (const action of [
    'dynamodb:GetItem',
    'dynamodb:Query',
    'dynamodb:PutItem',
    's3:GetObject',
    'lambda:InvokeFunction'
  ])
    assert.ok(actions.has(action), action);
  for (const via of ['media.bytes', 'media.download', 'capture'])
    assert.ok(
      made.some((r) => r.via === via),
      via
    );
  assert.ok(capture.granted().some((r) => r.via === 'TransactWriteCommand ConditionCheck'));
  // The web function platform's .local log group is not modelled here.
  assert.deepEqual(aws.unused(), [
    `logs:CreateLogStream arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda-web/${STACK}-mcp-native.local:*`,
    `logs:PutLogEvents arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda-web/${STACK}-mcp-native.local:*`
  ]);
});
