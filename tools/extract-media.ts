/** Old emailed-note attachment backfill. Counts only, dry run by default;
 * --write stages only valid photos, audio and PDFs, then proves the
 * note/account before adding media. Losers remove unreferenced files, never
 * raw mail or winner files. A note that already has media gains only the
 * PDFs its email carried and it lacks (Jamie, 2026-10-29: "Yes to old
 * PDFs.", after emailed PDFs began to be kept that day), appended after its
 * files and guarded by their count. `--all` runs every subscriber. */
import type { Store, Item } from '../packages/backend/store.ts';
import type { Objects } from '../packages/backend/services.ts';
import * as media from '../packages/backend/media.ts';
import { parseMessage, leaves } from '../packages/mail/parse.ts';
import {
  argumentsFor,
  writing,
  invoked,
  launch,
  runtime,
  scan,
  subscriber,
  guardedWrite,
  OperatorError
} from './operator.ts';
const emptyCounts = () => ({
  notes: 0,
  with_attachments: 0,
  already_done: 0,
  notes_filled: 0,
  files: 0,
  pdfs: 0,
  nothing_to_show: 0
});
/** PDFs kept from the note's own email: keyed by day and message, where a
 * file added on the web is under files/. */
const keptPdfs = (have: Item[]) =>
  have.filter((m) => m.kind === 'file' && !String(m.key ?? '').includes('/files/')).length;
/** PDFs the email listed and the note doesn't hold yet. */
function missingPdfs(item: Item, have: Item[]): number {
  const listed = (item.attachments as Item[]).filter((a) => {
    if (!a || typeof a !== 'object' || a.refused) return false;
    const type = media.mediaType(String(a.content_type ?? ''), String(a.filename ?? ''));
    return type !== null && type in media.PDF;
  }).length;
  return Math.max(0, listed - keptPdfs(have));
}
export async function extract(store: Store, objects: Objects, user: string, write = false) {
  const notes = await store.allNotes(user),
    counts = { ...emptyCounts(), notes: notes.length };
  for (const item of notes) {
    const raw = String(item.raw_key ?? '');
    if (!raw.startsWith('raw/') || !Array.isArray(item.attachments) || !item.attachments.length) continue;
    counts.with_attachments++;
    const had = 'media' in item,
      have = (Array.isArray(item.media) ? item.media : []) as Item[];
    if (had && !missingPdfs(item, have)) {
      counts.already_done++;
      continue;
    }
    const message = await parseMessage((await objects.get(raw, { maxBytes: 40 * 1024 * 1024 })).body),
      parts = media.found(
        leaves(message)
          .filter((p) => p.disposition === 'attachment' || !p.type.startsWith('text/'))
          .map((p) => ({ type: p.type, filename: p.filename, data: p.content }))
      ),
      // A note with media keeps what it has, and gains its email's PDFs past
      // those already kept, up to the files a note may hold.
      files = had
        ? parts
            .filter(([type]) => media.kind(type) === 'file')
            .slice(keptPdfs(have))
            .slice(0, Math.max(0, media.MAX_FILES - have.length))
        : parts;
    if (!files.length) {
      counts.nothing_to_show++;
      continue;
    }
    const pdfs = files.filter(([type]) => media.kind(type) === 'file').length;
    counts.notes_filled++;
    counts.files += files.length;
    counts.pdfs += pdfs;
    if (!write) continue;
    const [, day, id] = String(item.sk).split('#');
    if (!day || !id) throw new OperatorError('Invalid note key');
    const first = Math.max(0, ...have.map((m) => Number(m.n) || 0)) + 1,
      entries: media.MediaEntry[] = [];
    try {
      for (const [i, [type, body, name]] of files.entries()) {
        const n = first + i,
          key = media.key(user, day, id, n, type);
        await objects.put(key, body, { type, disposition: 'inline', tags: { outcome: 'pending' } });
        entries.push({ n, kind: media.kind(type), type, size: body.length, key, ...(name ? { name } : {}) });
      }
      const saved = await guardedWrite(store, user, {
        Update: {
          TableName: store.tableName,
          Key: { pk: String(item.pk), sk: String(item.sk) },
          ...(had
            ? {
                UpdateExpression: 'SET media = list_append(media, :m)',
                ConditionExpression: 'attribute_exists(pk) AND size(media) = :k',
                ExpressionAttributeValues: { ':m': entries, ':k': have.length }
              }
            : {
                UpdateExpression: 'SET media = :m',
                ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(media)',
                ExpressionAttributeValues: { ':m': entries }
              })
        }
      });
      const current = saved ? { media: [...have, ...entries] } : await store.note(user, day, id, true);
      const kept = new Set(((current?.media ?? []) as Item[]).map((m) => String(m.key)));
      for (const entry of entries)
        if (kept.has(entry.key)) await objects.tag(entry.key, { outcome: 'note' });
        else await objects.remove(entry.key);
      if (!saved) {
        counts.notes_filled--;
        counts.files -= entries.length;
        counts.pdfs -= pdfs;
      }
    } catch {
      const current = await store.note(user, day, id, true),
        kept = new Set(((current?.media ?? []) as Item[]).map((m) => String(m.key)));
      for (const entry of entries) if (!kept.has(entry.key)) await objects.remove(entry.key);
      throw new Error('Media backfill failed');
    }
  }
  return { dry_run: !write, ...counts };
}
/** Every subscriber's backfill, summed: counts only, never a person. */
export async function extractAll(store: Store, objects: Objects, write = false) {
  const profiles = await scan(store, {
      FilterExpression: 'sk = :p',
      ProjectionExpression: 'pk, mcp_deleting',
      ExpressionAttributeValues: { ':p': 'PROFILE' }
    }),
    total = { subscribers: 0, skipped: 0, ...emptyCounts() };
  for (const p of profiles) {
    total.subscribers++;
    if (p.mcp_deleting) {
      total.skipped++;
      continue;
    }
    const one = await extract(store, objects, String(p.pk).replace(/^USER#/, ''), write);
    for (const k of Object.keys(emptyCounts()) as (keyof ReturnType<typeof emptyCounts>)[]) total[k] += one[k];
  }
  return { dry_run: !write, ...total };
}
export async function main(args: string[]) {
  const { positionals, values } = argumentsFor(args, { all: { type: 'boolean', default: false } });
  if (values.help) {
    console.log('tools/extract-media.ts EMAIL|--all [--write|--dry-run] — counts only');
    return;
  }
  const write = writing(values);
  if (values.all) {
    if (positionals.length) throw new OperatorError('Usage: tools/extract-media.ts --all [--write]');
    const s = await runtime(write);
    console.log(JSON.stringify(await extractAll(s.store, s.objects, write)));
    return;
  }
  if (positionals.length !== 1) throw new OperatorError('Usage: tools/extract-media.ts EMAIL|--all [--write]');
  const s = await runtime(write),
    [user] = await subscriber(s.store, positionals[0]!);
  console.log(JSON.stringify(await extract(s.store, s.objects, user, write)));
}
if (invoked(import.meta.url)) await launch(main);
