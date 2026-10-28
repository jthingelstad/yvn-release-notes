/** Birthday versions match the sibling site's fixture-backed arithmetic.
 * A release is an anniversary-to-anniversary year, including leap rollover. */
import { addDays, anniversary, daysBetween, parseDay, type Day } from './dates.ts';
import { codePointLength, decimalDigit } from './unicode.ts';
export interface Version {
  major: number;
  minor: number;
  patch: number;
  age: number;
  cycleDays: number;
  daysUntil: number;
  toString(): string;
}

export function computeVersion(birthday: Day, today: Day): Version {
  const born = parseDay(birthday);
  let year = parseDay(today).year;
  let last = anniversary(year, born.month, born.day);
  if (today < last) last = anniversary(--year, born.month, born.day);
  const next = anniversary(year + 1, born.month, born.day),
    age = year - born.year;
  const major = Math.floor(age / 10),
    minor = ((age % 10) + 10) % 10,
    patch = daysBetween(last, today);
  return {
    major,
    minor,
    patch,
    age,
    cycleDays: daysBetween(last, next),
    daysUntil: daysBetween(today, next),
    toString: () => `${major}.${minor}.${patch}`
  };
}

/** Weeks and days lived, a nod to Four Thousand Weeks. Both count from 1, so
 * the day you were born is Week 1, Day 1 (the version counts from 0). */
export function lifeCount(v: Version, birthday: Day): { week: number; day: number } {
  const lived = daysBetween(birthday, releaseSpan(birthday, v.age)[0]) + v.patch;
  return { week: Math.floor(lived / 7) + 1, day: lived + 1 };
}
export const livedText = (l: { week: number; day: number }, dash = '\u2014') =>
  `Week ${l.week.toLocaleString('en-US')} ${dash} Day ${l.day.toLocaleString('en-US')}`;

export function sameDayBefore(birthday: Day, today: Day): Day[] {
  const born = parseDay(birthday),
    version = computeVersion(birthday, today),
    out: Day[] = [];
  for (let age = version.age - 1; age >= 0; age--) {
    const start = anniversary(born.year + age, born.month, born.day),
      end = anniversary(born.year + age + 1, born.month, born.day);
    const day = addDays(start, version.patch);
    if (day < end) out.push(day);
  }
  return out;
}

export function releaseName(age: number): string {
  return `${Math.floor(age / 10)}.${((age % 10) + 10) % 10}`;
}
export function releaseAge(name: string): number | null {
  if (typeof name !== 'string') return null;
  const parts = name.split('.');
  if (
    parts.length !== 2 ||
    codePointLength(parts[0]!) < 1 ||
    codePointLength(parts[0]!) > 3 ||
    codePointLength(parts[1]!) !== 1
  )
    return null;
  let value = 0;
  for (const char of parts.join('')) {
    const digit = decimalDigit(char);
    if (digit === undefined) return null;
    value = value * 10 + digit;
  }
  return value;
}
export function releaseSpan(birthday: Day, age: number): [Day, Day] {
  if (!Number.isInteger(age)) throw new RangeError('Invalid release age');
  const born = parseDay(birthday),
    first = anniversary(born.year + age, born.month, born.day);
  return [first, addDays(anniversary(born.year + age + 1, born.month, born.day), -1)];
}
