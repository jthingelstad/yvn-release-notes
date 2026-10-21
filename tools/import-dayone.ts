/** Manual Day One plan/report/import tool. Default plans only. --write means
 * the operator explicitly approved this run; no agent should invoke it live.
 * Private plan files stay outside Git repositories, directory0700/file0600,
 * exclusively created. Console output is aggregate counts and calendar ranges. */
import { mkdir, realpath, stat, writeFile, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as dayone from '../packages/backend/dayone.ts';
import * as importer from '../packages/backend/importer.ts';
import * as tags from '../packages/domain/tags.ts';
import { computeStreak, pauseDays } from '../packages/domain/streak.ts';
import { localDay, iso } from '../packages/domain/dates.ts';
import { rounded, fetchJson, type JsonFetch } from '../packages/backend/places.ts';
import * as weather from '../packages/backend/weather.ts';
import { fetchTitle } from '../packages/backend/links.ts';
import type { Store, Item } from '../packages/backend/store.ts';
import { argumentsFor, writing, invoked, launch, runtime, subscriber, query, OperatorError } from './operator.ts';
export const ITEM_LIMIT = 400 * 1024;
/** Match the old report's conservative JSON-size approximation, with Python's
 * default separators and ASCII escapes. This is not a DynamoDB byte guarantee. */
export function legacyJson(value: unknown, ascii = true, space?: number): string {
  if (space !== undefined) return JSON.stringify(value, null, space);
  const json = JSON.stringify(value);
  let out = '',
    quoted = false,
    escaped = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i]!;
    if (quoted) {
      if (ascii && char.charCodeAt(0) > 127) out += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      else out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else {
      if (char === '"') quoted = true;
      out += char;
      if (char === ',' || char === ':') out += ' ';
    }
  }
  return out;
}
const frequency = (values: Iterable<string>) => {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
};
export function storedSize(item: Item) {
  const media = ((item.media ?? []) as Item[]).map((m) =>
    Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'from'))
  );
  return Buffer.byteLength(legacyJson({ ...item, media }));
}
export function summary(plan: dayone.Plan): Item {
  const notes = plan.notes,
    days = new Set(notes.map((n) => n.date)),
    files: Record<string, number> = {},
    fileBytes: Record<string, number> = {},
    tagSet = new Set<string>();
  let tagged = 0,
    extraTags = 0;
  for (const n of notes) {
    for (const m of n.item.media ?? []) {
      const kind = String(m.kind);
      files[kind] = (files[kind] ?? 0) + 1;
      fileBytes[kind] = (fileBytes[kind] ?? 0) + Number(m.size);
    }
    const found = (n.item.tags ?? []) as string[];
    tagged += Number(found.length > 0);
    found.forEach((t) => tagSet.add(t));
    const line = new Set(tags.found(n.tag_line));
    extraTags += Number(found.some((t) => !line.has(t)));
  }
  const biggest = Math.max(0, ...notes.map((n) => storedSize(n.item))),
    rawBytes = notes.reduce((sum, n) => sum + Buffer.byteLength(legacyJson(n.original, false)), 0),
    places = notes.map((n) => n.item.place).filter(Boolean),
    urls = new Set(notes.flatMap((n) => n.urls)),
    named = new Set(notes.flatMap((n) => Object.keys(n.named))),
    ordered = [...days].sort();
  return {
    main_journal: plan.journal === dayone.MAIN_JOURNAL,
    notes: notes.length,
    skipped: frequency(plan.skipped.map((n) => n.why)),
    days: days.size,
    first_day: ordered[0] ?? null,
    last_day: ordered.at(-1) ?? null,
    busiest_day_notes: Math.max(0, ...Object.values(frequency(notes.map((n) => n.date)))),
    text: plan.counts,
    files,
    file_mb: Object.fromEntries(Object.entries(fileBytes).map(([k, v]) => [k, rounded(v / 1e6, 1)])),
    missing_files: plan.missing_files,
    tags: { notes_tagged: tagged, distinct: tagSet.size, notes_with_hashtags_in_text: extraTags },
    place_from: plan.place_from,
    places: Object.fromEntries(
      ['label', 'venue', 'address', 'city', 'accuracy_m'].map((k) => [k, places.filter((p) => p && k in p).length])
    ),
    photos_with_their_own_spot: notes.flatMap((n) => n.item.media ?? []).filter((m) => m.place).length,
    originals_kb: rounded(rawBytes / 1024),
    zones_renamed: notes.filter((n) => typeof n.zone_was === 'string' && Object.hasOwn(dayone.ZONES, n.zone_was))
      .length,
    all_day: notes.filter((n) => n.all_day).length,
    starred: notes.filter((n) => n.starred).length,
    links: {
      urls: urls.size,
      named_by_writer: [...named].filter((u) => urls.has(u)).length,
      need_titles: [...urls].filter((u) => !named.has(u)).length
    },
    largest_item_kb: rounded(biggest / 1024, 1),
    largest_item_fits: biggest < ITEM_LIMIT
  };
}
export async function report(plans: dayone.Plan[], store: Store, user: string, today: string): Promise<Item> {
  const notes = plans.flatMap((p) => p.notes),
    importDays = new Set(notes.map((n) => n.date)),
    ids = frequency(notes.map((n) => n.id)),
    weatherDays = dayone.weatherDays(notes),
    live = await query(store, user, 'NOTE#', { ProjectionExpression: 'sk' }),
    liveDays = new Set(live.map((i) => String(i.sk).split('#')[1]!)),
    liveIds = new Set(live.map((i) => String(i.sk).split('#').slice(2).join('#'))),
    keptWeather = new Set(Object.keys(await store.weatherBetween(user, '0000-00-00', '9999-99-99'))),
    pauses = await store.pauses(user),
    paused = pauseDays(pauses, today),
    joinedDays = new Set([...liveDays, ...importDays]);
  const streak = (days: Set<string>) => {
    const s = computeStreak(days, today, paused);
    return { current: s.current, longest: s.longest };
  };
  return {
    dry_run: true,
    journals: plans.map((p) => ({ entries: p.notes.length + p.skipped.length, ...summary(p) })),
    all: {
      notes: notes.length,
      days: importDays.size,
      days_in_more_than_one_journal: [...importDays].filter(
        (day) => plans.filter((p) => p.notes.some((n) => n.date === day)).length > 1
      ).length,
      busiest_day_notes: Math.max(0, ...Object.values(frequency(notes.map((n) => n.date)))),
      same_id_twice: Object.values(ids).filter((n) => n > 1).length
    },
    live: { notes: live.length, days: liveDays.size, pauses: pauses.length },
    overlap: {
      days_with_live_notes: [...importDays].filter((day) => liveDays.has(day)).length,
      notes_already_imported: Object.keys(ids).filter((id) => liveIds.has(id)).length,
      days_with_weather_kept: [...importDays].filter((day) => keptWeather.has(day)).length,
      days_after_today: [...importDays].filter((day) => day > today).length
    },
    weather: {
      days_to_fetch: Object.keys(weatherDays).filter((day) => !keptWeather.has(day) && day !== today).length,
      days_without_place: [...importDays].filter((day) => !weatherDays[day]).length
    },
    streak_before: streak(liveDays),
    streak_after: streak(joinedDays),
    lifetime: { notes_after: live.length + notes.length, days_after: joinedDays.size }
  };
}
async function existingAncestor(path: string) {
  let current = path;
  while (true) {
    try {
      return { existing: current, real: await realpath(current) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw new OperatorError('Invalid private plan directory');
      current = parent;
    }
  }
}
export async function privatePlanDirectory(path: string): Promise<string> {
  const target = resolve(path),
    ancestor = await existingAncestor(target),
    canonical = resolve(ancestor.real, target.slice(ancestor.existing.length).replace(/^\//, ''));
  let cursor = canonical;
  while (true) {
    try {
      await lstat(resolve(cursor, '.git'));
      throw new OperatorError('--plan-out contains note text: choose a directory outside Git repositories');
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  try {
    const found = await lstat(target);
    if (found.isSymbolicLink() || !found.isDirectory() || (found.mode & 0o077) !== 0)
      throw new OperatorError('--plan-out needs a private directory (mode700), without symlinks');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(target, { recursive: true, mode: 0o700 });
  }
  if ((await stat(target)).mode & 0o077) throw new OperatorError('--plan-out needs a private directory (mode700)');
  return await realpath(target);
}
export async function savePlans(plans: dayone.Plan[], path: string): Promise<void> {
  const directory = await privatePlanDirectory(path),
    names = new Set<string>();
  for (const plan of plans) {
    const name = `plan-${tags.slug(plan.journal) || 'journal'}.json`;
    if (names.has(name)) throw new OperatorError('Journal plan filenames collide');
    names.add(name);
  }
  for (const plan of plans)
    await writeFile(
      resolve(directory, `plan-${tags.slug(plan.journal) || 'journal'}.json`),
      JSON.stringify(plan, null, 1),
      { flag: 'wx', mode: 0o600 }
    );
}
export async function sampleWeather(
  plans: dayone.Plan[],
  store: Store,
  user: string,
  today: string,
  n: number,
  fetcher: JsonFetch = fetchJson,
  pause = 0.2
) {
  if (!Number.isSafeInteger(n) || n < 0) throw new OperatorError('--weather-sample must be a nonnegative integer');
  const days = dayone.weatherDays(plans.flatMap((p) => p.notes)),
    have = await store.weatherBetween(user, '0000-00-00', '9999-99-99'),
    eligible = Object.keys(days)
      .filter((d) => d < today && !have[d])
      .sort(),
    count = Math.min(n, eligible.length);
  let answered = 0;
  for (let i = 0; i < count; i++) {
    const day = eligible[Math.floor((i * eligible.length) / count)]!;
    if (pause) await new Promise((resolve) => setTimeout(resolve, pause * 1000));
    try {
      answered += Number(!!(await weather.history(days[day]!, day, today, fetcher)));
    } catch {
      /* A bounded sample reports misses, never provider messages. */
    }
  }
  return { sampled: count, answered };
}
export async function main(args: string[]) {
  const { positionals, values } = argumentsFor(args, {
    'plan-out': { type: 'string' },
    'weather-sample': { type: 'string', default: '0' }
  });
  if (values.help) {
    console.log(
      'tools/import-dayone.ts EMAIL ZIP... [--plan-out PRIVATE_DIR] [--weather-sample N] [--write] — counts-only plan first; each live write needs human approval'
    );
    return;
  }
  if (positionals.length < 2) throw new OperatorError('Usage: tools/import-dayone.ts EMAIL ZIP... [--write]');
  const write = writing(values),
    s = await runtime(write),
    [user, profile] = await subscriber(s.store, positionals[0]!),
    today = localDay(Date.now() / 1000, String(profile.tz)),
    archives: dayone.Archive[] = [];
  try {
    for (const path of positionals.slice(1)) archives.push(await dayone.read(path));
    const plans = archives.map((a) => dayone.plan(a.journal, a.entries, a.names, profile, user)),
      result = await report(plans, s.store, user, today);
    if (typeof values['plan-out'] === 'string') await savePlans(plans, values['plan-out']);
    const n = Number(values['weather-sample']);
    if (n) Object.assign(result.weather as Item, await sampleWeather(plans, s.store, user, today, n));
    if (!Number.isSafeInteger(n) || n < 0) throw new OperatorError('--weather-sample must be a nonnegative integer');
    console.log(JSON.stringify(result, null, 1));
    if (write) {
      if (plans.some((p) => p.missing_files)) throw new OperatorError('Refusing: the export is missing files');
      if (plans.some((p) => summary(p).largest_item_fits !== true))
        throw new OperatorError('Refusing: a planned note exceeds the item-size estimate');
      const started = performance.now();
      const counts = await importer.write(
        plans.map((p, i) => [p, archives[i]!.read]),
        user,
        {
          ...s,
          today,
          at: iso(Date.now() / 1000),
          fetchTitle,
          fetchWeather: fetchJson,
          pause: 0.2,
          log: (fields) => console.log(JSON.stringify(fields)),
          progress: (c) => {
            if (c.notes! > 0 && c.notes! % 50 === 0)
              console.log(
                JSON.stringify({
                  notes: c.notes,
                  files: c.files,
                  seconds: Math.round((performance.now() - started) / 1000)
                })
              );
          }
        }
      );
      console.log(JSON.stringify({ written: counts }, null, 1));
    }
  } finally {
    archives.forEach((a) => a.close());
  }
}
if (invoked(import.meta.url)) await launch(main);
