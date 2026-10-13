/** Opt-in audio transcription. Fixed job names, USER-owned atomic leases and a
 * capped UTC-day counter bound repeated stream deliveries to 30 starts/day.
 * Results require live consent and the same media; provider jobs/results are
 * cleaned even when consent was withdrawn or the note/account was removed. */
import { randomUUID } from 'node:crypto';
import type { NoteRecord } from '../domain/notes.ts';
import { missing, type Objects, type Log } from './services.ts';
import type { Store, Item } from './store.ts';
export const PREFIX = 'release-notes',
  LANGUAGE = 'en-US',
  MAX_TRANSCRIPT = 50_000,
  MAX_A_DAY = 30,
  MAX_BYTES = 50 * 1024 * 1024,
  ONE_DAY = 86400;
export const FORMATS: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac'
};
export type Job = [user: string, day: string, id: string, n: number];
export function jobName(user: string, day: string, id: string, n: number): string | null {
  return /^[A-Za-z0-9-]{1,80}$/.test(user) &&
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    /^[A-Za-z0-9-]{1,80}$/.test(id) &&
    Number.isSafeInteger(n) &&
    n >= 0
    ? `${PREFIX}.${user}.${day}.${id}.${n}`
    : null;
}
export function parseJob(name: string): Job | null {
  const [prefix, user, day, id, index, ...rest] = name.split('.');
  if (rest.length || prefix !== PREFIX || !user || !day || !id || !index || !/^\d+$/.test(index)) return null;
  const n = Number(index);
  return jobName(user, day, id, n) === name ? [user, day, id, n] : null;
}
export const outputKey = (user: string, day: string, id: string, n: number) =>
  `transcripts/${user}/${day}/${id}/${n}.json`;
export function waiting(note: NoteRecord) {
  return (note.media ?? []).filter(
    (m) =>
      m.kind === 'audio' &&
      Object.hasOwn(FORMATS, String(m.type)) &&
      !('transcript' in m) &&
      Number(m.size ?? 0) <= MAX_BYTES &&
      String(m.key ?? '').startsWith('media/')
  );
}
export interface Transcriptions {
  start(job: { name: string; format: string; key: string; outputKey: string }): Promise<void>;
  remove(name: string): Promise<void>;
}
export interface Services {
  store: Store;
  objects: Objects;
  transcriptions: Transcriptions;
  clock?: () => number;
  log?: Log;
}
export async function wanted(store: Store, user: string) {
  const p = await store.profile(user, true);
  return Boolean(p?.transcribe && !p.mcp_deleting);
}
export async function start(note: NoteRecord, user: string, s: Services): Promise<number> {
  const [, day, id] = String(note.sk).split('#');
  if (!day || !id) return 0;
  let started = 0;
  for (const m of waiting(note)) {
    const n = Number(m.n),
      name = jobName(user, day, id, n),
      key = String(m.key),
      type = String(m.type),
      owner = randomUUID();
    if (!name || !key.startsWith(`media/${user}/`)) continue;
    const now = Math.floor((s.clock ?? (() => Date.now() / 1000))());
    if (!(await s.store.claimProcessing('transcribe', user, day, id, n, key, type, owner, now))) continue;
    // The transaction authorizes this work; a fresh read also catches a stop
    // already committed between the reservation and the external service call.
    if (!(await wanted(s.store, user))) {
      await s.store.releaseProcessing(user, 'transcribe', day, id, n, owner);
      continue;
    }
    try {
      await s.transcriptions.start({ name, format: FORMATS[type]!, key, outputKey: outputKey(user, day, id, n) });
      started++;
    } catch (error) {
      if ((error as Error).name !== 'ConflictException') {
        await s.store.releaseProcessing(user, 'transcribe', day, id, n, owner);
        throw error;
      }
    }
  }
  if (started) s.log?.({ event: 'transcribe-start', user, started });
  return started;
}
export async function finished(detail: Item, s: Services): Promise<string> {
  const name = String(detail.TranscriptionJobName ?? ''),
    job = parseJob(name);
  if (!job) return 'not-ours';
  const status = String(detail.TranscriptionJobStatus ?? '');
  if (!['COMPLETED', 'FAILED'].includes(status)) return 'not-finished';
  const [user, day, id, n] = job,
    key = outputKey(...job),
    lease = await s.store.processing(user, 'transcribe', day, id, n);
  const note = await s.store.note(user, day, id, true),
    entry = (note?.media as Item[] | undefined)?.find((m) => Number(m.n) === n);
  let text = '';
  if (status === 'COMPLETED')
    try {
      const body = JSON.parse((await s.objects.get(key, { maxBytes: 8 * 1024 * 1024 })).body.toString('utf8')) as Item;
      const transcripts = (body.results as Item | undefined)?.transcripts;
      if (!Array.isArray(transcripts)) throw new Error('Malformed transcription result');
      text = transcripts
        .map((t) => (typeof (t as Item).transcript === 'string' ? (t as Item).transcript : ''))
        .join(' ')
        .trim();
    } catch (error) {
      if (!missing(error)) throw new Error('Transcription result unavailable');
    }
  text = Array.from(text).slice(0, MAX_TRANSCRIPT).join('');
  // Legacy Python jobs have no lease. They can finish after alias cutover, with
  // the same live consent/current entry proof. New jobs use their saved source.
  const source = String(lease?.source ?? entry?.key ?? ''),
    type = String(lease?.type ?? entry?.type ?? '');
  const kept =
    source.startsWith(`media/${user}/`) &&
    Object.hasOwn(FORMATS, type) &&
    (await s.store.finishProcessing(
      'transcribe',
      user,
      day,
      id,
      n,
      source,
      type,
      text,
      lease ? String(lease.owner) : null
    ));
  await s.objects.remove(key);
  try {
    await s.transcriptions.remove(name);
  } catch (error) {
    if (!['NotFoundException', 'BadRequestException'].includes((error as Error).name)) throw error;
  }
  if (lease) await s.store.releaseProcessing(user, 'transcribe', day, id, n, String(lease.owner));
  const outcome = kept ? 'kept' : 'note-gone';
  s.log?.({ event: 'transcribe-done', user, status, outcome, chars: Array.from(text).length });
  return outcome;
}
