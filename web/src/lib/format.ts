// Dates, times and counts as the pages say them.

const parts = (iso: string) => iso.split('-').map(Number) as [number, number, number];

// "June 14, 1981"
export function longDate(iso: string): string {
  const [y, m, d] = parts(iso);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// "6:00 AM" for "06:00"
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// "Thursday, October 8", with the year when it isn't this one.
export function dayName(iso: string, thisYear?: number): string {
  const [y, m, d] = parts(iso);
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };
  if (thisYear && y !== thisYear) opts.year = 'numeric';
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
}

// "October 8", with the year when it isn't this one.
export function shortDay(iso: string, thisYear: number): string {
  const [y, m, d] = parts(iso);
  const opts: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric' };
  if (y !== thisYear) opts.year = 'numeric';
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
}

// A stored UTC time, read in a zone.
export const zoneTime = (at: string, tz: string) =>
  new Date(at).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
export const zoneShortDate = (at: string, tz: string) =>
  new Date(at).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });

export function zoneName(at: string, tz: string): string | undefined {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(at))
    .find((x) => x.type === 'timeZoneName')?.value;
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const thisYearOf = (today: string) => Number(today.slice(0, 4));

export const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export function megabytes(n: number): string {
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} KB`;
  return n < 1e9 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : `${(n / 1e9).toFixed(1)} GB`;
}

// Every quarter hour, as the sender allows: ["00:00", "00:15", ...].
export const SEND_TIMES = Array.from({ length: 96 }, (_, i) => {
  const m = i * 15;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});

// The browser's own zone.
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// "Paused through Thursday, October 15. ..." or, not yet begun, from and through.
export function pauseLine(p: { pause?: { from: string; through: string }; today: string; send_time: string }): string {
  if (!p.pause) return '';
  const { from, through } = p.pause;
  const on = (iso: string) => dayName(iso, thisYearOf(p.today));
  if (from > p.today) return `Paused from ${on(from)} through ${on(through)}.`;
  return `Paused through ${on(through)}. They start again ${on(addDays(through, 1))} at ${clock(p.send_time)}.`;
}
