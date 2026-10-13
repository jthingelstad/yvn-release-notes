/** Historical home-city weather backfill. Counts only. Dry run by default;
 * --write conditionally fills missing days, with the current account proof. */
import type { Store } from '../packages/backend/store.ts';
import * as weather from '../packages/backend/weather.ts';
import { fetchJson, type JsonFetch } from '../packages/backend/places.ts';
import { localDay, iso } from '../packages/domain/dates.ts';
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
export async function fill(
  store: Store,
  user: string,
  write = false,
  fetch: JsonFetch = fetchJson,
  now = Date.now() / 1000,
  pause = 0.2
) {
  const profile = await store.profile(user, true),
    place = profile ? weather.placeOf(profile) : null;
  if (!place) throw new OperatorError('That subscriber has no city');
  const today = localDay(now, place.tz),
    days = [...(await store.noteDays(user))].filter((day) => day < today).sort(),
    have = await store.weatherBetween(user, '0000-00-00', '9999-99-99'),
    counts = { days_with_notes: days.length, already_kept: 0, kept: 0, no_answer: 0, changed: 0 };
  for (const day of days) {
    if (have[day]) {
      counts.already_kept++;
      continue;
    }
    if (pause) await new Promise((resolve) => setTimeout(resolve, pause * 1000));
    let reading: weather.Reading | null;
    try {
      reading = await weather.history(place, day, today, fetch);
    } catch {
      reading = null;
    }
    if (!reading) {
      counts.no_answer++;
      continue;
    }
    counts.kept++;
    if (!write) continue;
    const saved = await guardedWrite(store, user, {
      Put: {
        TableName: store.tableName,
        Item: { pk: `USER#${user}`, sk: `WEATHER#${day}`, ...weather.record(reading, place, iso(now)) },
        ConditionExpression: 'attribute_not_exists(sk)'
      }
    });
    if (!saved) {
      counts.kept--;
      counts.changed++;
    }
  }
  return { dry_run: !write, ...counts };
}
export async function main(args: string[]) {
  const { positionals, values } = argumentsFor(args);
  if (values.help) {
    console.log('tools/fill-weather.ts EMAIL [--write|--dry-run] — counts only');
    return;
  }
  if (positionals.length !== 1) throw new OperatorError('Usage: tools/fill-weather.ts EMAIL [--write]');
  const write = writing(values),
    s = await runtime(write),
    [user] = await subscriber(s.store, positionals[0]!);
  console.log(JSON.stringify(await fill(s.store, user, write)));
}
if (invoked(import.meta.url)) await launch(main);
