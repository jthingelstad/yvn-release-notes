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

/** How far a zone's clock is ahead of UTC at an instant, in seconds. */
function offsetAt(epoch: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(new Date(epoch * 1000)),
    get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const shown = utc(get('year'), get('month'), get('day')).getTime() / 1000;
  return shown + get('hour') * 3600 + get('minute') * 60 + get('second') - epoch;
}

/** The first instant (epoch seconds) of a subscriber-local day: its local
 * midnight, or where a zone skips midnight, the first local moment after it. */
export function localStart(value: Day, timezone: string): number {
  const { year, month, day } = parseDay(value);
  if (!validTimezone(timezone)) throw new RangeError('Invalid timezone');
  const wall = utc(year, month, day).getTime() / 1000;
  let start = wall - offsetAt(wall, timezone);
  start = wall - offsetAt(start, timezone);
  // Midnight fell in a gap: step back to the day's first quarter hour.
  while (localDay(start - 900, timezone) === value) start -= 900;
  while (localDay(start, timezone) < value) start += 900;
  return start;
}

/** When a subscriber-local day's clock reaches a time ("06:30"), in RFC 3339
 * with the zone's offset then: the moment the morning email is due, as the
 * sender's quarter-hour ticks find it. A time the clock skips is the first
 * quarter hour after the change, and a time it shows twice is the first. */
export function localMoment(value: Day, time: string, timezone: string): string {
  const { year, month, day } = parseDay(value),
    [h, m] = time.split(':').map(Number);
  if (!validTimezone(timezone) || !/^\d{2}:\d{2}$/.test(time) || h! > 23 || m! > 59)
    throw new RangeError('Invalid time or timezone');
  const wall = utc(year, month, day).getTime() / 1000 + h! * 3600 + m! * 60;
  let at = wall - offsetAt(wall, timezone);
  at = wall - offsetAt(at, timezone);
  while (at + offsetAt(at, timezone) < wall) at += 900;
  const offset = offsetAt(at, timezone),
    shown = new Date((at + offset) * 1000).toISOString().slice(0, 19),
    sign = offset < 0 ? '-' : '+',
    abs = Math.abs(offset);
  return `${shown}${sign}${String(Math.floor(abs / 3600)).padStart(2, '0')}:${String(Math.floor((abs % 3600) / 60)).padStart(2, '0')}`;
}

export function iso(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) throw new RangeError('Invalid timestamp');
  const value = new Date(Math.floor(epochSeconds) * 1000);
  if (!Number.isFinite(value.getTime()) || value.getUTCFullYear() < 1 || value.getUTCFullYear() > 9999)
    throw new RangeError('Invalid timestamp');
  return value.toISOString().replace('.000Z', 'Z');
}
