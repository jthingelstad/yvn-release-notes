/** The transcribe function's role grants what its stream and Transcribe events
 * request: the lease and job start (with what Transcribe then does as the
 * caller), turning transcripts on for every note, a finished job's result read,
 * kept and cleaned up, and a failed job's cleanup (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import type { Item } from '../../packages/backend/store.ts';
import * as t from '../../packages/backend/transcribe.ts';
import * as worker from '../../workers/transcribe.ts';
import { stream } from '../processing/helpers.ts';
import { Recorder, REGION, ACCOUNT } from './grants.ts';

const now = Date.parse('2026-10-13T12:00:00Z') / 1000,
  day = '2026-10-12';
const audio = (id: string) => ({
  n: 0,
  key: `media/u/${day}/${id}/0.mp3`,
  kind: 'audio',
  type: 'audio/mpeg',
  size: 1024
});
const note = (id: string): Item => ({
  pk: 'USER#u',
  sk: `NOTE#${day}#${id}`,
  text: 'A synthetic fixture',
  media: [audio(id)]
});

test('the transcribe role grants every request a stream record and a finished job make', async () => {
  const aws = new Recorder('TranscribeFunction'),
    bucket = aws.env.BUCKET!,
    profile = { pk: 'USER#u', sk: 'PROFILE', email: 'ada@example.com', birthday: '1972-03-05', tz: 'America/Chicago' },
    store = new FakeStore([{ ...profile, transcribe: true }, note('a'), note('b'), note('c')]),
    files = new FakeObjects(),
    job = (input: Item) =>
      `arn:aws:transcribe:${REGION}:${ACCOUNT}:transcription-job/${String(input.TranscriptionJobName)}`,
    // The real adapter, over a client that records each command as IAM sees it.
    client = {
      async send(command: { constructor: { name: string }; input: Item }) {
        const { input } = command;
        if (command.constructor.name === 'StartTranscriptionJobCommand') {
          aws.add('transcribe.start', 'transcribe:StartTranscriptionJob', '*', {
            'transcribe:OutputBucketName': String(input.OutputBucketName),
            'transcribe:OutputKey': String(input.OutputKey)
          });
          // Transcribe reads the media and writes the result as the caller,
          // after proving it can write to the output bucket.
          const media = String((input.Media as Item).MediaFileUri).replace(/^s3:\/\//, 'arn:aws:s3:::');
          aws.add('Transcribe as caller', 's3:GetObject', media);
          aws.add('Transcribe as caller', 's3:PutObject', `arn:aws:s3:::${bucket}/.write_access_check_file.temp`);
          aws.add('Transcribe as caller', 's3:PutObject', `arn:aws:s3:::${bucket}/${String(input.OutputKey)}`);
        } else {
          assert.equal(command.constructor.name, 'DeleteTranscriptionJobCommand');
          aws.add('transcribe.remove', 'transcribe:DeleteTranscriptionJob', job(input));
        }
        return {};
      }
    },
    services: t.Services = {
      store: aws.watch(store),
      objects: aws.objects(files),
      transcriptions: worker.createTranscriptions(bucket, client as never),
      clock: () => now
    },
    finished = (id: string, status: string) =>
      worker.runEvent(
        {
          source: 'aws.transcribe',
          detail: { TranscriptionJobName: t.jobName('u', day, id, 0), TranscriptionJobStatus: status }
        },
        services
      );

  await worker.runEvent({ Records: [stream(note('a'))] }, services);
  // Turning transcripts on starts every waiting recording.
  await worker.runEvent({ Records: [stream({ ...profile, transcribe: true }, profile)] }, services);
  await files.put(
    t.outputKey('u', day, 'a', 0),
    Buffer.from(JSON.stringify({ results: { transcripts: [{ transcript: 'Synthetic words' }] } })),
    { type: 'application/json' }
  );
  await finished('a', 'COMPLETED');
  assert.equal(
    (store.memory.read({ pk: 'USER#u', sk: `NOTE#${day}#a` })!.media as Item[])[0]?.transcript,
    'Synthetic words'
  );
  await finished('b', 'FAILED');
  // The note is deleted before its job finishes: the result is still cleaned up.
  await aws.aside(store, null, () => store.deleteNote('u', day, 'c'));
  await finished('c', 'COMPLETED');

  for (const action of ['transcribe:StartTranscriptionJob', 'transcribe:DeleteTranscriptionJob'])
    assert.equal(aws.requests.filter((r) => r.action === action).length, 3, action);
  const made = aws.granted(),
    actions = new Set(made.map((r) => r.action));
  for (const action of [
    'transcribe:StartTranscriptionJob',
    'transcribe:DeleteTranscriptionJob',
    'dynamodb:ConditionCheckItem',
    'dynamodb:Query',
    's3:GetObject',
    's3:DeleteObject',
    'dynamodb:GetRecords'
  ])
    assert.ok(actions.has(action), action);
  assert.deepEqual(aws.unused(), [], 'every grant is used');
});
