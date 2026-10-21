/** Execute already-reviewed import plans. Ordered file/original staging precedes
 * atomic note+ledger commits; all references require a live account.
 * Each attempt stages at unique object keys, so a losing concurrent import
 * cannot overwrite the bytes already referenced by the winning note. Repeat
 * skips the ledger even if its owner deleted a note. Console/reporting counts
 * contain no text, tags, coordinates, addresses, filenames or object keys.
 * A run that imported anything leaves one activity row with its counts. */
import { randomUUID } from 'node:crypto';
import type { Store, Item } from './store.ts';
import type { Objects } from './services.ts';
import type { Day } from '../domain/dates.ts';
import * as dayone from './dayone.ts';
import * as tags from '../domain/tags.ts';
import * as links from './links.ts';
import * as weather from './weather.ts';
import type { JsonFetch } from './places.ts';
import { eventId, recordActivity } from './activity.ts';
export const ledger = (plan: dayone.Plan) =>
  `IMPORT#${(plan.notes[0]?.item.origin as Item | undefined)?.app ?? 'import'}#${tags.slug(plan.journal) || 'journal'}`;
export interface Services {
  store: Store;
  objects: Objects;
  today: Day;
  at: string;
  fetchTitle?: links.TitleFetcher;
  fetchWeather?: JsonFetch;
  pause?: number;
  progress?: (counts: Record<string, number>) => void;
  log?: (fields: { event: string; kind: string; user: string }) => void;
}
export type Input = readonly [plan: dayone.Plan, read: (name: string) => Promise<Buffer> | Buffer];
function keys(note: Item): Set<string> {
  return new Set([String(note.raw_key ?? ''), ...((note.media ?? []) as Item[]).map((m) => String(m.key))]);
}
function attemptKey(key: string, attempt: string): string {
  const dot = key.lastIndexOf('.');
  return dot > key.lastIndexOf('/') ? `${key.slice(0, dot)}-${attempt}${key.slice(dot)}` : `${key}-${attempt}`;
}
export async function write(plans: readonly Input[], user: string, s: Services): Promise<Record<string, number>> {
  if (plans.some(([p]) => p.missing_files > 0)) throw new Error('Import refused: missing export files');
  const counts: Record<string, number> = Object.fromEntries(
    [
      'notes',
      'already_imported',
      'id_taken',
      'files',
      'file_bytes',
      'originals',
      'links_named',
      'links_titled',
      'weather_kept',
      'weather_had',
      'weather_no_answer'
    ].map((k) => [k, 0])
  );
  const taken = await s.store.noteIds(user),
    imported = await s.store.importedIds(user);
  for (const [plan, read] of plans) {
    const book = ledger(plan),
      done = await s.store.imported(user, book);
    for (const n of plan.notes.toSorted((a, b) =>
      String(a.item.written_at) < String(b.item.written_at)
        ? -1
        : String(a.item.written_at) > String(b.item.written_at)
          ? 1
          : 0
    )) {
      const uuid = String((n.item.origin as Item).id);
      if (done.has(uuid) || imported.has(uuid)) {
        counts.already_imported!++;
        continue;
      }
      if (taken.has(n.id)) {
        counts.id_taken!++;
        continue;
      }
      const profile = await s.store.profile(user, true);
      if (!profile || profile.mcp_deleting) throw new Error('Import account unavailable');
      const attempt = randomUUID(),
        files = n.files.map((file) => ({ ...file, key: attemptKey(file.key, attempt) })),
        replacements = new Map(n.files.map((file, i) => [file.key, files[i]!.key])),
        item: Item = { ...n.item, raw_key: attemptKey(String(n.item.raw_key), attempt) };
      if (Array.isArray(n.item.media))
        item.media = (n.item.media as Item[]).map((entry) => {
          const key = replacements.get(String(entry.key));
          if (!key) throw new Error('Import media plan mismatch');
          return { ...entry, key };
        });
      const staged: string[] = [];
      let committed = false;
      try {
        for (const f of files) {
          const body = await read(f.from);
          await s.objects.put(f.key, body, { type: f.type, disposition: 'inline', tags: { outcome: 'pending' } });
          staged.push(f.key);
          counts.files!++;
          counts.file_bytes! += body.length;
        }
        const raw = String(item.raw_key);
        await s.objects.put(raw, Buffer.from(JSON.stringify(n.original, null, 1)), {
          type: 'application/json',
          tags: { outcome: 'ignored' }
        });
        staged.push(raw);
        counts.originals!++;
        const found = await links.collect(String(item.text ?? ''), { named: n.named, fetch: s.fetchTitle });
        if (found.length) {
          item.links = found.map((link) => ({ ...link }));
          counts.links_named! += found.filter((l) => l.named).length;
          counts.links_titled! += found.filter((l) => !l.named).length;
        }
        committed = await s.store.putImportedNote(user, n.date, n.id, item, book, uuid, s.at);
        if (committed) {
          counts.notes!++;
          done.add(uuid);
          imported.add(uuid);
          taken.add(n.id);
        } else counts.id_taken!++;
        const kept = committed ? keys(item) : keys((await s.store.note(user, n.date, n.id, true)) ?? {});
        for (const key of staged)
          if (kept.has(key)) await s.objects.tag(key, { outcome: 'note' });
          else await s.objects.remove(key);
      } catch {
        if (!committed) {
          const kept = keys((await s.store.note(user, n.date, n.id, true)) ?? {});
          for (const key of staged)
            if (kept.has(key)) await s.objects.tag(key, { outcome: 'note' });
            else await s.objects.remove(key);
        }
        throw new Error('Import write failed');
      }
      if (!committed) {
        const current = await s.store.profile(user, true);
        if (!current || current.mcp_deleting) throw new Error('Import account unavailable');
      }
      s.progress?.({ ...counts });
    }
  }
  if (s.fetchWeather) {
    const kept = await s.store.weatherBetween(user, '0000-00-00', '9999-99-99'),
      days = dayone.weatherDays(plans.flatMap(([p]) => p.notes));
    for (const [day, place] of Object.entries(days)) {
      if (day >= s.today) continue;
      if (kept[day]) {
        counts.weather_had!++;
        continue;
      }
      if (s.pause) await new Promise((resolve) => setTimeout(resolve, s.pause! * 1000));
      let reading: weather.Reading | null;
      try {
        reading = await weather.history(place, day, s.today, s.fetchWeather);
      } catch {
        reading = null;
      }
      if (!reading) {
        counts.weather_no_answer!++;
        continue;
      }
      try {
        if (await s.store.forLiveAccount(user).putWeather(user, day, weather.record(reading, place, s.at)))
          counts.weather_kept!++;
        else counts.weather_had!++;
      } catch (error) {
        if ((error as Error).name === 'ProcessingAccountGone') {
          const profile = await s.store.profile(user, true);
          if (!profile || profile.mcp_deleting) throw new Error('Import account unavailable');
          counts.weather_had!++;
        } else throw new Error('Import weather write failed');
      }
    }
  }
  if (counts.notes)
    await recordActivity(
      s.store,
      user,
      Date.parse(s.at) / 1000,
      [
        {
          kind: 'import.notes',
          id: eventId(),
          fields: { via: 'import', app: dayone.APP, notes: counts.notes, files: counts.files }
        }
      ],
      s.log
    );
  return counts;
}
