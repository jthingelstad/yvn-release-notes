/** Count-only operations census from Store.censusItems' projection. One scheduled
 * sender run emits raw JSON EMF after its work; dry-run/send_now emit none.
 * Dates and overdue time are subscriber-local. No identity or note content is
 * copied to the output. Any scan/timezone failure is caught by the sender. */
import type { Item, Store } from './store.ts';
import { addDays, localDay } from '../domain/dates.ts';

export const NAMESPACE = 'ReleaseNotes';
export const GRACE_SECONDS = 30 * 60;
export type Counts = Record<string, number>;
const METRICS = [
  'Subscribers',
  'Paused',
  'Stopped',
  'Overdue',
  'Notes',
  'EmailNotes',
  'WebNotes',
  'ImportedNotes',
  'AgentNotes',
  'NotesWithMedia',
  'Writers7',
  'Writers30'
];
const noteDay = (row: Item): string => String(row.sk).split('#')[1]!;
const between = (day: string, first: string, last: string) => first <= day && day <= last;
const hasMedia = (row: Item) => Array.isArray(row.media) && row.media.length > 0;

/** Python round(value, 1): nearest decimal tenth, ties to even. Using the
 * actual IEEE-754 value also preserves Python's binary-float edge cases. */
function roundTenth(value: number): number {
  if (!value) return 0;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0),
    exponent = Number((bits >> 52n) & 0x7ffn) - 1075,
    mantissa = (bits & ((1n << 52n) - 1n)) | (1n << 52n),
    numerator = mantissa * 10n;
  if (exponent >= 0) return Number(numerator << BigInt(exponent)) / 10;
  const denominator = 1n << BigInt(-exponent),
    whole = numerator / denominator,
    remainder = numerator % denominator,
    twice = remainder * 2n,
    rounded = whole + (twice > denominator || (twice === denominator && whole % 2n !== 0n) ? 1n : 0n);
  return Number(rounded) / 10;
}

function overdue(profile: Item, today: string, now: number, timezone: string): boolean {
  if (String(profile.last_sent_date || '') >= today) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(new Date(now * 1000)),
    read = (key: string) => Number(parts.find((part) => part.type === key)?.value),
    [hour, minute] = String(profile.send_time === undefined ? '06:00' : profile.send_time)
      .split(':')
      .map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour! < 0 || hour! > 23 || minute! < 0 || minute! > 59) {
    throw new RangeError('Invalid send time');
  }
  const wallSeconds = read('hour') * 3600 + read('minute') * 60 + read('second') + (now - Math.floor(now));
  return wallSeconds > hour! * 3600 + minute! * 60 + GRACE_SECONDS;
}

export function counts(items: Item[], now: number): Counts {
  const byUser = new Map<string, Item[]>(),
    totals: Counts = Object.fromEntries(METRICS.map((name) => [name, 0]));
  for (const item of items) {
    const key = String(item.pk),
      rows = byUser.get(key) ?? [];
    rows.push(item);
    byUser.set(key, rows);
  }
  let sent = 0,
    replied = 0;
  for (const rows of byUser.values()) {
    const notes = rows.filter((row) => String(row.sk).startsWith('NOTE#')),
      web = notes.filter((row) => row.source === 'web').length,
      imported = notes.filter((row) => row.source === 'import').length,
      agent = notes.filter((row) => row.source === 'agent').length;
    totals.Notes! += notes.length;
    totals.WebNotes! += web;
    totals.ImportedNotes! += imported;
    totals.AgentNotes! += agent;
    totals.EmailNotes! += notes.length - web - imported - agent;
    totals.NotesWithMedia! += notes.filter(hasMedia).length;
    const profile = rows.find((row) => row.sk === 'PROFILE');
    if (!profile?.tz) continue;
    const timezone = String(profile.tz),
      today = localDay(now, timezone),
      noted = new Set(notes.map(noteDay)),
      emailed = new Set(rows.filter((row) => String(row.sk).startsWith('DAY#')).map(noteDay));
    if ([...noted].some((day) => between(day, addDays(today, -6), today))) totals.Writers7!++;
    if ([...noted].some((day) => between(day, addDays(today, -29), today))) totals.Writers30!++;
    const recent = [...emailed].filter((day) => between(day, addDays(today, -30), addDays(today, -1)));
    sent += recent.length;
    replied += recent.filter((day) => noted.has(day)).length;
    if ((profile.status === undefined ? 'active' : profile.status) !== 'active') totals.Stopped!++;
    else if (
      profile.pause_from &&
      profile.pause_through &&
      String(profile.pause_from) <= today &&
      today <= String(profile.pause_through)
    ) {
      totals.Paused!++;
    } else {
      totals.Subscribers!++;
      if (overdue(profile, today, now, timezone)) totals.Overdue!++;
    }
  }
  if (sent) totals.ReplyRate30 = roundTenth((100 * replied) / sent);
  return totals;
}

export function line(values: Counts, now: number) {
  return {
    _aws: {
      Timestamp: Math.trunc(now * 1000),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [[]],
          Metrics: Object.keys(values).map((name) => ({
            Name: name,
            Unit: name === 'ReplyRate30' ? 'Percent' : 'Count'
          }))
        }
      ]
    },
    event: 'census',
    ...values
  };
}

export async function report(
  store: Pick<Store, 'censusItems'>,
  now: number,
  emit: (value: ReturnType<typeof line>) => void = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
): Promise<void> {
  emit(line(counts(await store.censusItems(), now), now));
}
