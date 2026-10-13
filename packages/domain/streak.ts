/** Email streaks end yesterday. Paused empty days are skipped; notes on
 * paused days count. Late replies mend their original day. */
import { addDays, validDay, type Day } from './dates.ts';
export interface Streak {
  current: number;
  longest: number;
  days: Day[];
}
export function computeStreak(noteDays: Iterable<Day>, today: Day, paused: Iterable<Day> = []): Streak {
  const have = new Set([...noteDays].filter((d) => d < today)),
    skip = new Set([...paused].filter((d) => d < today && !have.has(d)));
  const run: Day[] = [];
  let day = addDays(today, -1);
  while (have.has(day) || skip.has(day)) {
    if (have.has(day)) run.push(day);
    // Python dates also stop at their representable boundary.
    if (day === '0001-01-01') break;
    day = addDays(day, -1);
  }
  let longest = 0,
    length = 0,
    previous: Day | undefined;
  for (const value of [...have].sort()) {
    let joined = previous !== undefined;
    if (previous !== undefined)
      for (let d = addDays(previous, 1); d < value; d = addDays(d, 1))
        if (!skip.has(d)) {
          joined = false;
          break;
        }
    length = joined ? length + 1 : 1;
    longest = Math.max(longest, length);
    previous = value;
  }
  return { current: run.length, longest, days: run.reverse() };
}
export function pauseDays(pauses: Iterable<readonly [Day, Day]>, until: Day): Set<Day> {
  if (!validDay(until)) throw new RangeError('Invalid pause day');
  const days = new Set<Day>();
  for (const [start, through] of pauses) {
    if (!validDay(start) || !validDay(through)) throw new RangeError('Invalid pause day');
    const end = through < until ? through : until;
    for (let day = start; day <= end; day = addDays(day, 1)) {
      days.add(day);
      if (day === end) break;
    }
  }
  return days;
}
