/** Old emailed-note attachment backfill. Counts only, dry run by default;
 * --write stages only valid photos/audio then proves the note/account before
 * adding media. Losers remove unreferenced files, never raw mail or winner files. */
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
  subscriber,
  guardedWrite,
  OperatorError
} from './operator.ts';
export async function extract(store: Store, objects: Objects, user: string, write = false) {
  const notes = await store.allNotes(user),
    counts = {
      notes: notes.length,
      with_attachments: 0,
      already_done: 0,
      notes_filled: 0,
      files: 0,
      nothing_to_show: 0
    };
  for (const item of notes) {
    const raw = String(item.raw_key ?? '');
    if (!raw.startsWith('raw/') || !Array.isArray(item.attachments) || !item.attachments.length) continue;
    counts.with_attachments++;
    if ('media' in item) {
      counts.already_done++;
      continue;
    }
    const message = await parseMessage((await objects.get(raw, { maxBytes: 40 * 1024 * 1024 })).body),
      files = media.found(
        leaves(message)
          .filter((p) => p.disposition === 'attachment' || !p.type.startsWith('text/'))
          .map((p) => ({ type: p.type, filename: p.filename, data: p.content }))
      );
    if (!files.length) {
      counts.nothing_to_show++;
      continue;
    }
    counts.notes_filled++;
    counts.files += files.length;
    if (!write) continue;
    const [, day, id] = String(item.sk).split('#');
    if (!day || !id) throw new OperatorError('Invalid note key');
    const entries: media.MediaEntry[] = [];
    try {
      for (const [i, [type, body]] of files.entries()) {
        const key = media.key(user, day, id, i + 1, type);
        await objects.put(key, body, { type, disposition: 'inline', tags: { outcome: 'pending' } });
        entries.push({ n: i + 1, kind: media.kind(type), type, size: body.length, key });
      }
      const saved = await guardedWrite(store, user, {
        Update: {
          TableName: store.tableName,
          Key: { pk: String(item.pk), sk: String(item.sk) },
          UpdateExpression: 'SET media = :m',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(media)',
          ExpressionAttributeValues: { ':m': entries }
        }
      });
      const current = saved ? { media: entries } : await store.note(user, day, id, true);
      const kept = new Set(((current?.media ?? []) as Item[]).map((m) => String(m.key)));
      for (const entry of entries)
        if (kept.has(entry.key)) await objects.tag(entry.key, { outcome: 'note' });
        else await objects.remove(entry.key);
      if (!saved) {
        counts.notes_filled--;
        counts.files -= entries.length;
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
export async function main(args: string[]) {
  const { positionals, values } = argumentsFor(args);
  if (values.help) {
    console.log('tools/extract-media.ts EMAIL [--write|--dry-run] — counts only');
    return;
  }
  if (positionals.length !== 1) throw new OperatorError('Usage: tools/extract-media.ts EMAIL [--write]');
  const write = writing(values),
    s = await runtime(write),
    [user] = await subscriber(s.store, positionals[0]!);
  console.log(JSON.stringify(await extract(s.store, s.objects, user, write)));
}
if (invoked(import.meta.url)) await launch(main);
