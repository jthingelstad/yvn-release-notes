/** The export function's role grants what a build requests: the owner's rows,
 * each file read, the zip uploaded (in parts when large), the guarded finish,
 * the archive removed when a newer build wins, a failed build's mark, and a
 * book with Claude's commentary, its key read from the runtime secret and its
 * count kept with the finish (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { claudeFrom, run, runBook } from '../../workers/export.ts';
import type { Writer } from '../../packages/book/commentary.ts';
import { Recorder, REGION, ACCOUNT } from './grants.ts';

const now = Date.parse('2026-10-13T07:00:00Z') / 1000;
test('the export role grants every request a build, a replaced build, a failed build and an annotated book make', async () => {
  const aws = new Recorder('ExportFunction'),
    store = new FakeStore(),
    files = new FakeObjects();
  await store.createSubscriber('u1', 'ada@example.com', {
    birthday: '1981-06-14',
    tz: 'America/Chicago',
    status: 'active'
  });
  await store.putNote('u1', '2026-10-12', 'w-a', {
    text: 'Lake day.',
    source: 'web',
    written_at: '2026-10-12T20:00:00Z',
    media: [
      { n: 1, kind: 'image', type: 'image/jpeg', key: 'media/u1/files/a.jpg', size: 5 },
      { n: 2, kind: 'audio', type: 'audio/mp4', key: 'media/u1/files/missing.m4a', size: 5 }
    ]
  });
  await files.put('media/u1/files/a.jpg', Buffer.from('photo'), { type: 'image/jpeg' });
  // Builds start in the web app, under its own role.
  const start = (id: string, at: number) => aws.aside(store, null, () => store.startExport('u1', id, at, at + 960));
  await start('build-a', now);
  const context = { store: aws.watch(store), objects: aws.objects(files), now, clock: () => now, log: () => undefined };

  assert.equal(await run(context, 'u1', 'build-a'), 'ready');
  await start('build-b', now + 10);
  const upload = files.uploadFile.bind(files);
  files.uploadFile = async (...args) => {
    await upload(...args);
    await start('build-c', now + 20);
  };
  assert.equal(await run(context, 'u1', 'build-b'), 'replaced');
  assert.ok(files.calls.some((c) => c.operation === 'remove' && c.key === 'exports/u1/build-b.zip'));
  files.uploadFile = upload;

  // A book with commentary: the real secret adapter over a client that
  // records the command as IAM authorizes it, and a made-up key and model.
  await aws.aside(store, null, () =>
    store.startExport('u1', 'book-a', now, now + 86400, 'BOOK', {
      from: '2026-10-12',
      to: '2026-10-12',
      commentary: true,
      release: 45
    })
  );
  const secrets = {
      async send(command: { input: { SecretId: string } }) {
        aws.add(
          'secrets.get',
          'secretsmanager:GetSecretValue',
          `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${command.input.SecretId}-AbCdEf`
        );
        return { SecretString: JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-synthetic' }) };
      }
    },
    opus: Writer = async () => ({
      text: JSON.stringify({ introduction: 'One lake day.', months: [], days: [], afterword: '' }),
      stop: 'end_turn',
      usage: { input: 1, output: 1 }
    });
  const book = { ...context, writer: claudeFrom(aws.env.SECRET!, secrets as never, () => opus) };
  assert.equal(await runBook(book, 'u1', 'book-a'), 'ready');
  assert.equal(store.memory.read({ pk: 'USER#u1', sk: 'COMMENTARY#45' })?.made, 1);
  files.get = async () => {
    throw new Error('Unavailable');
  };
  await assert.rejects(run(context, 'u1', 'build-c'));
  assert.equal(store.memory.read({ pk: 'USER#u1', sk: 'EXPORT' })?.status, 'failed');

  const actions = new Set(aws.granted().map((r) => r.action));
  for (const action of [
    'dynamodb:Query',
    'dynamodb:UpdateItem',
    's3:GetObject',
    's3:PutObject',
    's3:DeleteObject',
    'secretsmanager:GetSecretValue'
  ])
    assert.ok(actions.has(action), action);
  assert.deepEqual(aws.unused(), [], 'every grant is used');
});
