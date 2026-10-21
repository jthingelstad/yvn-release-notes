import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as t from '../../packages/backend/transcribe.ts';
import * as worker from '../../workers/transcribe.ts';
import { setup, audio, day, id, now, stream } from './helpers.ts';
import type { Item } from '../../packages/backend/store.ts';
const configured = () => {
  const s = setup([audio()]),
    starts: Item[] = [],
    removed: string[] = [];
  const services: t.Services = {
    ...s.services,
    transcriptions: {
      async start(job) {
        starts.push(job);
      },
      async remove(name) {
        removed.push(name);
      }
    }
  };
  return { ...s, starts, removed, services };
};
test('canonical job names reject unsafe ids/noncanonical indexes; waiting preserves supported audio', () => {
  const good = t.jobName('u', day, id, 0)!;
  assert.deepEqual(t.parseJob(good), ['u', day, id, 0]);
  for (const name of [
    'foreign.u.2026-10-12.w-note.0',
    `${good}0`,
    good.replace('.0', '.01'),
    'release-notes.u.x.y.0',
    'release-notes.u.2026-10-12.w_note.0'
  ])
    assert.equal(t.parseJob(name), null);
  assert.equal(t.jobName('u/other', day, id, 0), null);
  assert.equal(t.jobName('u', day, id, -1), null);
  const waiting = t.waiting({
    media: [
      audio(),
      { ...audio(1), transcript: '' },
      { ...audio(2), type: 'audio/aac' },
      { ...audio(3), size: t.MAX_BYTES + 1 },
      { ...audio(4), key: 'https://elsewhere' },
      { ...audio(5), type: 'constructor' }
    ]
  });
  assert.deepEqual(waiting, [audio()]);
});
test('duplicate streams reserve/send one fixed job, opt-out sends none; fresh record ignores own stale image', async () => {
  const s = configured();
  await worker.changed(stream(s.note), s.services);
  await worker.changed(stream(s.note), s.services);
  assert.deepEqual(s.starts, [
    { name: t.jobName('u', day, id, 0), format: 'mp3', key: audio().key, outputKey: t.outputKey('u', day, id, 0) }
  ]);
  s.store.seed({ ...s.note, media: [{ ...audio(), transcript: 'already' }] });
  assert.equal(await worker.changed(stream(s.note), s.services), 0);
  const off = configured();
  off.store.seed({ ...off.profile, transcribe: false });
  assert.equal(await worker.changed(stream(off.note), off.services), 0);
  assert.equal(off.starts.length, 0);
});
test('profile enable starts old recordings but false/unchanged/foreign stream rows do nothing', async () => {
  const s = configured();
  assert.equal(await worker.changed(stream(s.profile, { ...s.profile, transcribe: false }), s.services), 1);
  assert.equal(await worker.changed(stream(s.profile, s.profile), s.services), 0);
  assert.equal(await worker.changed(stream({ pk: 'RATE#x', sk: 'RATE' }), s.services), 0);
});
test('Transcribe conflict retains fixed-name job lease; real start failure releases lease for retry', async () => {
  const s = configured();
  s.services.transcriptions.start = async () => {
    throw Object.assign(new Error('synthetic'), { name: 'ConflictException' });
  };
  assert.equal(await t.start(s.note, 'u', s.services), 0);
  assert.ok(await s.store.processing('u', 'transcribe', day, id, 0));
  const failed = configured();
  failed.services.transcriptions.start = async () => {
    throw new Error('private service detail');
  };
  await assert.rejects(() => worker.runEvent({ Records: [stream(failed.note)] }, failed.services), {
    message: 'Transcription worker failed'
  });
  assert.deepEqual(failed.logs.at(-1), { event: 'transcribe', outcome: 'failed', error: 'Error' });
  assert.equal(JSON.stringify(failed.logs).includes('private'), false);
  assert.equal(await failed.store.processing('u', 'transcribe', day, id, 0), null);
});
test('30job quota held across independent worker instances; oversized and overquota stay waiting', async () => {
  const s = configured();
  s.store.seed({ ...s.note, media: Array.from({ length: 31 }, (_, n) => audio(n)) });
  const row = (await s.store.note('u', day, id))!;
  assert.equal(await t.start(row, 'u', s.services), 30);
  assert.equal(await t.start(row, 'u', s.services), 0);
  assert.equal(s.starts.length, 30);
  assert.equal(((await s.store.note('u', day, id))!.media as Item[])[30]?.transcript, undefined);
});
test('completed lease and legacy Python job write text, preserve fields and clean resources', async () => {
  for (const legacy of [false, true]) {
    const s = configured();
    if (!legacy) await t.start(s.note, 'u', s.services);
    await s.objects.put(
      t.outputKey('u', day, id, 0),
      Buffer.from(JSON.stringify({ results: { transcripts: [{ transcript: 'First' }, { transcript: 'second' }] } })),
      { type: 'application/json' }
    );
    assert.equal(
      await t.finished(
        { TranscriptionJobName: t.jobName('u', day, id, 0), TranscriptionJobStatus: 'COMPLETED' },
        s.services
      ),
      'kept'
    );
    assert.deepEqual(((await s.store.note('u', day, id))!.media as Item[])[0], {
      ...audio(),
      transcript: 'First second'
    });
    assert.equal(await s.store.processing('u', 'transcribe', day, id, 0), null);
    assert.deepEqual(s.removed, [t.jobName('u', day, id, 0)]);
    assert.equal((await s.objects.list('transcripts/')).length, 0);
    // One activity row for the recording, never its words.
    const rows = await s.store.activityAll('u');
    assert.deepEqual(
      rows.map((r) => [r.kind, r.day, r.note, r.file, r.empty]),
      [['transcript.added', day, id, 0, false]]
    );
    assert.doesNotMatch(JSON.stringify(rows), /First|second/);
  }
});
test('failed/missing result becomes empty transcript; foreign/in-progress events untouched', async () => {
  for (const status of ['FAILED', 'COMPLETED']) {
    const s = configured();
    assert.equal(
      await t.finished(
        {
          TranscriptionJobName: t.jobName('u', day, id, 0),
          TranscriptionJobStatus: status,
          FailureReason: 'Never log private provider text'
        },
        s.services
      ),
      'kept'
    );
    assert.equal(((await s.store.note('u', day, id))!.media as Item[])[0]?.transcript, '');
    assert.equal(JSON.stringify(s.logs).includes('Never log'), false);
    assert.deepEqual(
      (await s.store.activityAll('u')).map((r) => [r.kind, r.empty]),
      [['transcript.added', true]]
    );
  }
  const s = configured();
  assert.equal(await t.finished({ TranscriptionJobName: 'foreign' }, s.services), 'not-ours');
  assert.equal(
    await t.finished(
      { TranscriptionJobName: t.jobName('u', day, id, 0), TranscriptionJobStatus: 'IN_PROGRESS' },
      s.services
    ),
    'not-finished'
  );
  assert.equal(s.objects.calls.length, 0);
});
test('completion after opt-out/deletion/media replacement stores no text but cleans pending jobs', async () => {
  for (const mutation of ['optout', 'deleting', 'note-gone', 'replacement']) {
    const s = configured();
    await t.start(s.note, 'u', s.services);
    await s.objects.put(
      t.outputKey('u', day, id, 0),
      Buffer.from(JSON.stringify({ results: { transcripts: [{ transcript: 'private fixture' }] } })),
      { type: 'application/json' }
    );
    if (mutation === 'optout') s.store.seed({ ...s.profile, transcribe: false });
    else if (mutation === 'deleting') s.store.seed({ ...s.profile, mcp_deleting: true });
    else if (mutation === 'replacement')
      s.store.seed({ ...s.note, media: [{ ...audio(), key: 'media/u/replacement.mp3' }] });
    else await s.store.deleteNote('u', day, id);
    assert.equal(
      await t.finished(
        { TranscriptionJobName: t.jobName('u', day, id, 0), TranscriptionJobStatus: 'COMPLETED' },
        s.services
      ),
      'note-gone'
    );
    assert.equal(((await s.store.note('u', day, id))?.media as Item[] | undefined)?.[0]?.transcript, undefined);
    assert.equal(s.removed.length, 1);
    assert.equal(JSON.stringify(s.logs).includes('private fixture'), false);
    assert.deepEqual(await s.store.activityAll('u'), []);
  }
});
test('malformed result retries without cleanup; unicode truncation counts characters', async () => {
  const s = configured();
  const output = t.outputKey('u', day, id, 0);
  await s.objects.put(output, Buffer.from('bad JSON contains private'), { type: 'application/json' });
  await assert.rejects(
    () =>
      t.finished({ TranscriptionJobName: t.jobName('u', day, id, 0), TranscriptionJobStatus: 'COMPLETED' }, s.services),
    { message: 'Transcription result unavailable' }
  );
  assert.equal(s.removed.length, 0);
  await s.objects.put(
    output,
    Buffer.from(JSON.stringify({ results: { transcripts: [{ transcript: '😀'.repeat(t.MAX_TRANSCRIPT + 1) }] } })),
    { type: 'application/json' }
  );
  await t.finished(
    { TranscriptionJobName: t.jobName('u', day, id, 0), TranscriptionJobStatus: 'COMPLETED' },
    s.services
  );
  const text = String(((await s.store.note('u', day, id))!.media as Item[])[0]?.transcript);
  assert.equal(Array.from(text).length, t.MAX_TRANSCRIPT);
});
test('Transcribe SDK adapter emits precise service request fields and deletion', async () => {
  const calls: Item[] = [];
  const client = {
    async send(command: { input: Item }) {
      calls.push(command.input);
      return {};
    }
  };
  const adapter = worker.createTranscriptions('synthetic-bucket', client as never);
  await adapter.start({ name: 'job', key: 'media/u/audio.mp3', format: 'mp3', outputKey: 'transcripts/u/file.json' });
  await adapter.remove('job');
  assert.deepEqual(calls, [
    {
      TranscriptionJobName: 'job',
      LanguageCode: 'en-US',
      MediaFormat: 'mp3',
      Media: { MediaFileUri: 's3://synthetic-bucket/media/u/audio.mp3' },
      OutputBucketName: 'synthetic-bucket',
      OutputKey: 'transcripts/u/file.json'
    },
    { TranscriptionJobName: 'job' }
  ]);
});
test('stream SDK unmarshalling preserves native strings, numbers, bools and sets', () => {
  const row = { pk: 'USER#u', sk: 'PROFILE', transcribe: true, count: 3, tags: new Set(['fixture']) };
  assert.deepEqual(worker.images(stream(row)).new, row);
  assert.equal(Math.floor(now / t.ONE_DAY) > 0, true);
});
test('a new UTC day starts recordings left by quota, existing running jobs consume no new reservations', async () => {
  const s = configured();
  s.store.seed({ ...s.note, media: Array.from({ length: 31 }, (_, n) => audio(n)) });
  const note = (await s.store.note('u', day, id))!;
  await t.start(note, 'u', s.services);
  s.services.clock = () => now + 86400;
  assert.equal(await t.start(note, 'u', s.services), 1);
  assert.equal(s.starts.length, 31);
});
