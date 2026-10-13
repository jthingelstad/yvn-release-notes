/** Calendar days are canonical ISO strings. UTC is used only as a Gregorian
 * arithmetic carrier: subscriber-local dates never divide elapsed DST hours. */
export type Day = string;
const DAY_MS = 86_400_000;
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function utc(year: number, month: number, day: number): Date {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

export function formatDay(year: number, month: number, day: number): Day {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || !Number.isInteger(day))
    throw new RangeError('Invalid calendar day');
  const d = utc(year, month, day);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day)
    throw new RangeError('Invalid calendar day');
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseDay(value: string): CalendarDate {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))
    throw new RangeError('Invalid calendar day');
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  formatDay(year, month, day);
  return { year, month, day };
}

export function validDay(value: unknown): value is Day {
  try {
    parseDay(value as string);
    return true;
  } catch {
    return false;
  }
}

export function addDays(value: Day, count: number): Day {
  if (!Number.isInteger(count)) throw new RangeError('Calendar offset must be an integer');
  const { year, month, day } = parseDay(value);
  const result = new Date(utc(year, month, day).getTime() + count * DAY_MS);
  return formatDay(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate());
}

/** Signed count from the first day to the second day. */
export function daysBetween(first: Day, second: Day): number {
  const a = parseDay(first),
    b = parseDay(second);
  return (utc(b.year, b.month, b.day).getTime() - utc(a.year, a.month, a.day).getTime()) / DAY_MS;
}

export const isLeapYear = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
export function anniversary(year: number, month: number, day: number): Day {
  return month === 2 && day === 29 && !isLeapYear(year) ? formatDay(year, 3, 1) : formatDay(year, month, day);
}

export function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64 || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Epoch seconds, matching stored timestamps and worker clocks. */
export function localDay(epochSeconds: number, timezone: string): Day {
  if (!Number.isFinite(epochSeconds) || !validTimezone(timezone)) throw new RangeError('Invalid time or timezone');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    era: 'short'
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  if (get('era') !== 'AD') throw new RangeError('Invalid calendar day');
  return formatDay(Number(get('year')), Number(get('month')), Number(get('day')));
}

export function iso(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) throw new RangeError('Invalid timestamp');
  const value = new Date(Math.floor(epochSeconds) * 1000);
  if (!Number.isFinite(value.getTime()) || value.getUTCFullYear() < 1 || value.getUTCFullYear() > 9999)
    throw new RangeError('Invalid timestamp');
  return value.toISOString().replace('.000Z', 'Z');
}
