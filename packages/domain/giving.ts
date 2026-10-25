/** Giving (Jamie, 2026-10-25, of a badge for each year a Weekly Thing
 * Supporting Member gives: "Yearly giving badge is EXCELLENT!", and of the
 * birthday email naming it: "Love the birthday email idea too!"). Supporting
 * membership gives 100% to one nonprofit a calendar year, so a year seen as a
 * member is a year that gave to that year's nonprofit, which the copy names
 * up front wherever it says what members get.
 *
 * The profile keeps `giving`, a map from a calendar year ("2026") to the
 * first and last local days a Weekly Thing lookup answered `member` in it
 * (packages/backend/weekly-thing.ts). A year is only ever added or widened,
 * never removed: a lapsed member keeps every year they gave. Release Notes
 * first asked on 2026-10-25, so no year before 2026 is ever recorded. */
import type { Day } from './dates.ts';

export interface Nonprofit {
  /** As a badge names it: "Supported EFF". */
  short: string;
  /** As a sentence names it: "the year membership went to the Electronic
   * Frontier Foundation". */
  full: string;
}
/** One nonprofit a calendar year, as the Weekly Thing's members page has it
 * (weekly.thingelstad.com, `apps/site/_data/support.json`, `current` and
 * `past`). Add each year's when Jamie names it: a year seen before its
 * nonprofit is here waits, and its badge comes once it is added. */
export const NONPROFITS: Readonly<Record<number, Nonprofit>> = {
  2024: { short: 'Creative Commons', full: 'Creative Commons' },
  2025: { short: 'EFF', full: 'the Electronic Frontier Foundation' },
  2026: { short: 'Signal', full: 'Signal' }
};

export interface GivingYear {
  year: number;
  first: Day;
  last: Day;
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A profile's `giving`, oldest year first; anything malformed is left out. */
export function givingYears(value: unknown): GivingYear[] {
  if (!value || typeof value !== 'object') return [];
  const out: GivingYear[] = [];
  for (const [y, span] of Object.entries(value as Record<string, unknown>)) {
    const year = Number(y),
      { first, last } = (span ?? {}) as Record<string, unknown>;
    if (!/^\d{4}$/.test(y) || typeof first !== 'string' || typeof last !== 'string') continue;
    if (!DAY.test(first) || !DAY.test(last) || first > last) continue;
    out.push({ year, first, last });
  }
  return out.sort((a, b) => a.year - b.year);
}

/** `giving` after a lookup on local `day` answered `member`: the day's year
 * added, or its last day moved on. Null when nothing changes. */
export function sawMember(value: unknown, day: Day): Record<string, { first: Day; last: Day }> | null {
  const years = Object.fromEntries(givingYears(value).map((g) => [String(g.year), { first: g.first, last: g.last }])),
    year = day.slice(0, 4),
    had = years[year];
  if (had && had.first <= day && day <= had.last) return null;
  years[year] = had
    ? { first: had.first < day ? had.first : day, last: had.last > day ? had.last : day }
    : { first: day, last: day };
  return years;
}

/** The year's badge id, and back. */
export const givingId = (year: number) => `giving-${year}`;
export const givingYearOf = (id: string): number | null => {
  const m = /^giving-(\d{4})$/.exec(id);
  return m ? Number(m[1]) : null;
};

/** The nonprofits given to while `from`..`through` (a release) ran: each
 * recorded year whose days seen overlap it and whose nonprofit is known,
 * oldest first, by short name. */
export function givenDuring(value: unknown, from: Day, through: Day): string[] {
  return givingYears(value)
    .filter((g) => NONPROFITS[g.year] && g.first <= through && g.last >= from)
    .map((g) => NONPROFITS[g.year]!.short);
}

/** The birthday email's and the release page's thank-you. */
export const givingLine = (release: string, names: readonly string[]) =>
  names.length
    ? `During ${release} you supported ${names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`} as a Weekly Thing Supporting Member. Thank you.`
    : null;
