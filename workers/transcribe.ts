/** Existing transcription stream reader and Transcribe state-change target.
 * No new mapping, backfill trigger or automatic operator action is introduced. */
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  DeleteTranscriptionJobCommand
} from '@aws-sdk/client-transcribe';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { createStore, createObjects } from '../packages/backend/aws.ts';
import { safeLog } from '../packages/backend/services.ts';
import * as transcribe from '../packages/backend/transcribe.ts';
import type { Item } from '../packages/backend/store.ts';
export type StreamRecord = {
  dynamodb?: { NewImage?: Record<string, AttributeValue>; OldImage?: Record<string, AttributeValue> };
};
export function images(record: StreamRecord) {
  return { new: unmarshall(record.dynamodb?.NewImage ?? {}), old: unmarshall(record.dynamodb?.OldImage ?? {}) };
}
export async function changed(record: StreamRecord, s: transcribe.Services): Promise<number> {
  const image = images(record),
    row = image.new;
  if (!String(row.pk ?? '').startsWith('USER#')) return 0;
  const user = String(row.pk).slice(5);
  if (row.sk === 'PROFILE') {
    if (!row.transcribe || image.old.transcribe || !(await transcribe.wanted(s.store, user))) return 0;
    let started = 0;
    for (const note of await s.store.allNotes(user))
      if (transcribe.waiting(note).length) started += await transcribe.start(note, user, s);
    s.log?.({ event: 'transcribe-all', user, started });
    return started;
  }
  if (
    !String(row.sk ?? '').startsWith('NOTE#') ||
    !transcribe.waiting(row).length ||
    !(await transcribe.wanted(s.store, user))
  )
    return 0;
  const [, day, id] = String(row.sk).split('#');
  if (!day || !id) return 0;
  const note = await s.store.note(user, day, id, true);
  return note ? transcribe.start(note, user, s) : 0;
}
export function createTranscriptions(bucket: string, client = new TranscribeClient({})): transcribe.Transcriptions {
  return {
    async start(job) {
      await client.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: job.name,
          LanguageCode: transcribe.LANGUAGE,
          MediaFormat: job.format as 'm4a',
          Media: { MediaFileUri: `s3://${bucket}/${job.key}` },
          OutputBucketName: bucket,
          OutputKey: job.outputKey
        })
      );
    },
    async remove(name) {
      await client.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: name }));
    }
  };
}
let runtime: transcribe.Services | undefined;
function production() {
  const table = process.env.TABLE,
    bucket = process.env.BUCKET;
  if (!table || !bucket) throw new Error('Missing transcription configuration');
  return (runtime ??= {
    store: createStore(table),
    objects: createObjects(bucket),
    transcriptions: createTranscriptions(bucket),
    log: safeLog
  });
}
export async function runEvent(event: Item, injected?: transcribe.Services): Promise<Item | undefined> {
  if (event.self_test === true)
    return {
      ok: true,
      runtime: `Node ${process.versions.node}/${process.platform}/${process.arch}`,
      build: process.env.APP_VERSION ?? process.env.BUILD_SHA ?? process.env.BUILD ?? 'unknown'
    };
  const s = injected ?? production();
  try {
    if (event.source === 'aws.transcribe') {
      await transcribe.finished((event.detail ?? {}) as Item, s);
      return;
    }
    for (const record of (event.Records ?? []) as StreamRecord[]) await changed(record, s);
  } catch {
    throw new Error('Transcription worker failed');
  }
}

/** Node 24 promise-only entrypoint; dependency injection belongs to runEvent. */
export async function handler(event: Item, _context?: unknown): Promise<Item | undefined> {
  return runEvent(event);
}
