/** A moment: what an app picked for a note, kept with it as plain values
 * (docs/MOMENTS.md). Changelog sends one from Apple's Journaling
 * Suggestions; any `/v1` client may. The words stay the note; a moment is
 * kept beside them as it was picked, shown with the note, exported with it,
 * and deleted with it. Browser-safe: the web formats the same parts. */
import { codePointLength, pythonTrim } from './unicode.ts';

export const MOMENT_KINDS = [
  'workout',
  'song',
  'podcast',
  'played',
  'steps',
  'feeling',
  'event',
  'people',
  'reflection'
] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];
export const ACTIVITIES = ['walking', 'running', 'cycling', 'hiking', 'swimming', 'other'] as const;
export const MOVEMENTS = ['walking', 'running', 'both'] as const;
export const VALENCES = [
  'very_unpleasant',
  'unpleasant',
  'slightly_unpleasant',
  'neutral',
  'slightly_pleasant',
  'pleasant',
  'very_pleasant'
] as const;

/** At most this many pieces a moment. */
export const MOMENT_ITEMS = 12;
/** A name, title or place, in code points. */
export const MOMENT_WORDS = 200;
/** A reflection prompt, in code points. */
export const MOMENT_PROMPT = 400;
export const MOMENT_LABELS = 10;
export const MOMENT_PEOPLE = 20;

export type MomentItem =
  | {
      kind: 'workout';
      activity: (typeof ACTIVITIES)[number];
      name?: string;
      distance_m?: number;
      duration_s?: number;
    }
  | { kind: 'song'; title?: string; artist?: string }
  | { kind: 'podcast'; episode?: string; show?: string }
  | { kind: 'played'; title?: string; artist?: string }
  | { kind: 'steps'; count: number; movement?: (typeof MOVEMENTS)[number] }
  | { kind: 'feeling'; labels?: string[]; valence?: (typeof VALENCES)[number] }
  | { kind: 'event'; title: string; place?: string; start?: string; hosted: boolean }
  | { kind: 'people'; names: string[] }
  | { kind: 'reflection'; prompt: string };

export interface Moment {
  /** When the moment began, RFC 3339. */
  at?: string;
  items: MomentItem[];
}

/** A refused moment: what is wrong, and where (`moment.items[2].distance_m`). */
export interface MomentProblem {
  field: string;
  detail: string;
}

const FIELDS: Record<MomentKind, readonly string[]> = {
  workout: ['activity', 'name', 'distance_m', 'duration_s'],
  song: ['title', 'artist'],
  podcast: ['episode', 'show'],
  played: ['title', 'artist'],
  steps: ['count', 'movement'],
  feeling: ['labels', 'valence'],
  event: ['title', 'place', 'start', 'hosted'],
  people: ['names'],
  reflection: ['prompt']
};

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
/** A workout of up to 1,000 km and a week; a day of up to a million steps. */
const MAX_METRES = 1_000_000,
  MAX_SECONDS = 7 * 86400,
  MAX_STEPS = 1_000_000;

class Refused extends Error {
  constructor(
    readonly field: string,
    readonly detail: string
  ) {
    super(detail);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Trimmed words, or undefined when there are none; refused when too long. */
function words(value: unknown, field: string, max = MOMENT_WORDS): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Refused(field, `${field} is a string.`);
  const text = pythonTrim(value.replace(/\s+/g, ' '));
  if (codePointLength(text) > max) throw new Refused(field, `${field} can have at most ${max} characters.`);
  return text || undefined;
}
function needed(value: unknown, field: string, max?: number): string {
  const text = words(value, field, max);
  if (!text) throw new Refused(field, `${field} is needed.`);
  return text;
}
function oneOf<T extends string>(value: unknown, field: string, list: readonly T[]): T {
  if (typeof value !== 'string' || !list.includes(value as T))
    throw new Refused(field, `${field} is one of ${list.join(', ')}.`);
  return value as T;
}
function time(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 40 || !RFC3339.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Refused(field, `${field} is an RFC 3339 time.`);
  return value;
}
function amount(value: unknown, field: string, max: number, whole: boolean): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    (whole && !Number.isInteger(value))
  )
    throw new Refused(
      field,
      `${field} is a ${whole ? 'whole number' : 'number'} from 0 to ${max.toLocaleString('en-US')}.`
    );
  // Tenths of a metre or a second are as fine as anyone needs.
  return whole ? value : Math.round(value * 10) / 10;
}
function list(value: unknown, field: string, max: number, each: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max)
    throw new Refused(field, `${field} is a list of up to ${max} strings.`);
  const out: string[] = [];
  value.forEach((v, i) => {
    const text = words(v, `${field}[${i}]`, each);
    if (text && !out.includes(text)) out.push(text);
  });
  return out;
}

function item(value: unknown, at: string): MomentItem {
  if (!isObject(value)) throw new Refused(at, `${at} is an object with a kind.`);
  const kind = oneOf(value.kind, `${at}.kind`, MOMENT_KINDS);
  for (const key of Object.keys(value))
    if (key !== 'kind' && !FIELDS[kind].includes(key))
      throw new Refused(`${at}.${key}`, `${at}.${key} isn't a field of a ${kind}.`);
  const f = (name: string) => `${at}.${name}`;
  const pair = <A extends string, B extends string>(a: A, b: B) => {
    const one = words(value[a], f(a)),
      two = words(value[b], f(b));
    if (!one && !two) throw new Refused(f(a), `A ${kind} has a ${a} or a ${b}.`);
    return { ...(one ? { [a]: one } : {}), ...(two ? { [b]: two } : {}) } as Partial<Record<A | B, string>>;
  };
  switch (kind) {
    case 'workout': {
      const name = words(value.name, f('name')),
        distance = amount(value.distance_m, f('distance_m'), MAX_METRES, false),
        duration = amount(value.duration_s, f('duration_s'), MAX_SECONDS, false);
      return {
        kind,
        activity: oneOf(value.activity, f('activity'), ACTIVITIES),
        ...(name ? { name } : {}),
        ...(distance ? { distance_m: distance } : {}),
        ...(duration ? { duration_s: duration } : {})
      };
    }
    case 'song':
    case 'played':
      return { kind, ...pair('title', 'artist') };
    case 'podcast':
      return { kind, ...pair('episode', 'show') };
    case 'steps': {
      const count = amount(value.count, f('count'), MAX_STEPS, true);
      if (!count) throw new Refused(f('count'), `${f('count')} is a whole number from 1 to 1,000,000.`);
      const movement = value.movement === undefined ? undefined : oneOf(value.movement, f('movement'), MOVEMENTS);
      return { kind, count, ...(movement ? { movement } : {}) };
    }
    case 'feeling': {
      const labels = list(value.labels, f('labels'), MOMENT_LABELS, 40),
        valence = value.valence === undefined ? undefined : oneOf(value.valence, f('valence'), VALENCES);
      if (!labels.length && !valence) throw new Refused(f('labels'), 'A feeling has labels or a valence.');
      return { kind, ...(labels.length ? { labels } : {}), ...(valence ? { valence } : {}) };
    }
    case 'event': {
      const place = words(value.place, f('place')),
        start = time(value.start, f('start'));
      if (value.hosted !== undefined && typeof value.hosted !== 'boolean')
        throw new Refused(f('hosted'), `${f('hosted')} is true or false.`);
      return {
        kind,
        title: needed(value.title, f('title')),
        ...(place ? { place } : {}),
        ...(start ? { start } : {}),
        hosted: value.hosted === true
      };
    }
    case 'people': {
      const names = list(value.names, f('names'), MOMENT_PEOPLE, MOMENT_WORDS);
      if (!names.length) throw new Refused(f('names'), 'People have at least one name.');
      return { kind, names };
    }
    case 'reflection':
      return { kind, prompt: needed(value.prompt, f('prompt'), MOMENT_PROMPT) };
  }
}

/** A moment as sent, checked and tidied (words trimmed, empty ones left
 * out), or what is wrong with it. Unknown kinds and fields are refused, so
 * a new kind comes to Release Notes before an app sends it. */
export function momentOf(value: unknown): { moment: Moment } | { problem: MomentProblem } {
  try {
    if (!isObject(value)) throw new Refused('moment', 'moment is an object with items.');
    for (const key of Object.keys(value))
      if (key !== 'at' && key !== 'items')
        throw new Refused(`moment.${key}`, `moment.${key} isn't a field of a moment.`);
    const at = time(value.at, 'moment.at');
    if (!Array.isArray(value.items) || !value.items.length || value.items.length > MOMENT_ITEMS)
      throw new Refused('moment.items', `moment.items is a list of 1 to ${MOMENT_ITEMS} pieces.`);
    const items = value.items.map((v, i) => item(v, `moment.items[${i}]`));
    return { moment: { ...(at ? { at } : {}), items } };
  } catch (error) {
    if (error instanceof Refused) return { problem: { field: error.field, detail: error.detail } };
    throw error;
  }
}

/** A stored moment, as readers return it; anything unreadable is nothing. */
export function storedMoment(value: unknown): Moment | null {
  const read = momentOf(value);
  return 'moment' in read ? read.moment : null;
}

/** Its kinds, once each, in order: what an activity row says of it. */
export const momentKinds = (moment: Moment): MomentKind[] => [...new Set(moment.items.map((i) => i.kind))];

/** Where road signs give miles; elsewhere, kilometres. */
const MILES = new Set([
  'United States',
  'United Kingdom',
  'Liberia',
  'Myanmar',
  'Guam',
  'U.S. Virgin Islands',
  'Northern Mariana Islands',
  'American Samoa'
]);
export const usesMiles = (country: string | null | undefined): boolean => MILES.has(country ?? '');

const NOUNS: Record<(typeof ACTIVITIES)[number], string> = {
  walking: 'Walk',
  running: 'Run',
  cycling: 'Ride',
  hiking: 'Hike',
  swimming: 'Swim',
  other: 'Workout'
};
const count = (n: number) => Math.round(n).toLocaleString('en-US');
const and = (names: string[]) =>
  names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function distanceText(metres: number, swimming: boolean, miles: boolean): string {
  if (swimming) return miles ? `${count(metres * 1.0936133)} yd` : `${count(metres)} m`;
  const value = miles ? metres / 1609.344 : metres / 1000;
  return `${value < 10 ? value.toFixed(1) : count(value)} ${miles ? 'mi' : 'km'}`;
}
export function durationText(seconds: number): string {
  const minutes = Math.round(seconds / 60),
    hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  if (!hours) return `${minutes} min`;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/** One plain line a piece, for a page, an export or a mail: "Walk · 3.2 mi
 * · 48 min". Written by these rules alone, in the account's units. */
export function momentParts(moment: Moment, miles: boolean): { kind: MomentKind; text: string }[] {
  return moment.items.flatMap((i) => {
    const text = (() => {
      switch (i.kind) {
        case 'workout': {
          const parts = [i.activity === 'other' || !NOUNS[i.activity] ? (i.name ?? NOUNS.other) : NOUNS[i.activity]];
          if (i.distance_m && i.distance_m >= 10)
            parts.push(distanceText(i.distance_m, i.activity === 'swimming', miles));
          if (i.duration_s && i.duration_s >= 60) parts.push(durationText(i.duration_s));
          return parts.join(' · ');
        }
        case 'song':
        case 'played':
          return [i.title, i.artist].filter(Boolean).join(' · ');
        case 'podcast':
          return [i.episode, i.show].filter(Boolean).join(' · ');
        case 'steps':
          return `${count(i.count)} steps`;
        case 'feeling':
          return i.labels?.length ? sentence(i.labels.join(', ')) : sentence((i.valence ?? '').replace(/_/g, ' '));
        case 'event':
          return [i.title, i.place, i.hosted ? 'hosted' : ''].filter(Boolean).join(' · ');
        case 'people':
          return `With ${and(i.names)}`;
        case 'reflection':
          return i.prompt;
      }
    })();
    return text ? [{ kind: i.kind, text }] : [];
  });
}
