// Developer mode (docs/BADGES.md, Easter eggs): seven taps on Today's number
// turn it on, as on a phone's build number. These are the plain parts: the
// tap counter, the number in other bases, the clocks and the log's hashes.
// It is kept in this browser only, never on the server.
import { addDays, localStart } from '../../../packages/domain/dates.ts';

export const TAPS = 7;
// A gap longer than this starts the count over.
export const GAP_MS = 2000;
const KEY = 'rn-developer';

export interface Taps {
  count: number;
  last: number;
  on: boolean;
}
export const noTaps = (on = false): Taps => ({ count: 0, last: 0, on });

// One tap at `now` (ms): the next state, what the live region says, and
// whether this tap turned developer mode on.
export function tap(s: Taps, now: number): { next: Taps; say: string; turnedOn: boolean } {
  if (s.on) return { next: { ...s, last: now }, say: 'No need, you are already a developer.', turnedOn: false };
  const count = s.count && now - s.last <= GAP_MS ? s.count + 1 : 1;
  if (count >= TAPS)
    return { next: { count: 0, last: now, on: true }, say: 'You are now a developer.', turnedOn: true };
  const left = TAPS - count;
  return {
    next: { count, last: now, on: false },
    say: count >= 4 ? `${left} ${left === 1 ? 'tap' : 'taps'} from being a developer.` : '',
    turnedOn: false
  };
}

// Kept in this browser (localStorage), guarded as lib/storage.ts guards.
export const developer = {
  get(): boolean {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  },
  set(on: boolean) {
    try {
      if (on) localStorage.setItem(KEY, '1');
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode: on for this page only */
    }
  }
};

const parts = (v: string) => v.split('.').map(Number);
export const hex = (v: string) =>
  parts(v)
    .map((n) => n.toString(16))
    .join('.');
export const binary = (v: string) =>
  parts(v)
    .map((n) => n.toString(2))
    .join('.');
const ROMAN: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I']
];
// Roman numerals had no zero; medieval tables wrote N, for nulla.
export function roman(n: number): string {
  if (n === 0) return 'N';
  let out = '';
  for (const [value, mark] of ROMAN)
    while (n >= value) {
      out += mark;
      n -= value;
    }
  return out;
}
export const romanVersion = (v: string) => parts(v).map(roman).join('.');

// Seconds since local midnight on the birthday, in the profile's zone.
export const uptime = (birthday: string, tz: string, nowMs: number) =>
  Math.max(0, Math.floor(nowMs / 1000 - localStart(birthday, tz)));

// How far through today's patch, as a percent of the local day (a day of
// 23 or 25 hours where the clocks change).
export function patchDone(today: string, tz: string, nowMs: number): number {
  const start = localStart(today, tz),
    end = localStart(addDays(today, 1), tz);
  return Math.min(100, Math.max(0, ((nowMs / 1000 - start) * 100) / (end - start)));
}

// A short commit hash for a note: FNV-1a over its id, so the same note
// always gets the same seven hex digits.
export function shortHash(id: string): string {
  let h = 0x811c9dc5;
  for (const c of id) {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 7);
}

// A day's first few words, as a commit subject.
export function subject(text: string, words = 6): string {
  const all = text.split(/\s+/u).filter(Boolean);
  return all.length > words ? `${all.slice(0, words).join(' ')}…` : all.join(' ');
}
