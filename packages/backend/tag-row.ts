/** The tag row (docs/API.md, Tags; Jamie, 2026-10-29: "Pinned tags are good
 * and then also augmented with frequently used RECENT tags"): the pinned
 * tags (PROFILE.pinned_tags), the same on the web and through every token,
 * then the tags used most in the last 30 days, leaving out pinned ones,
 * ties broken by last use. */
import { addDays, type Day } from '../domain/dates.ts';
import { spelling, storedTags, tagKey, type Tag } from '../domain/tags.ts';
import type { Item } from './store-types.ts';

export const PINS_MAX = 12,
  RECENT_MAX = 20,
  RECENT_DAYS = 30;

/** A pinned list as the tags field takes names (docs/TAGS.md): "#Road
 * Trip" is Road Trip, each tag once by its key, in the order given; null
 * when it isn't a list of at most 12 tags. Stored as names (2026-11-08);
 * the keys stored before then read as names too. */
export function pinnedTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > PINS_MAX) return null;
  const out: Tag[] = [];
  for (const entry of value) {
    const tag = spelling(entry);
    if (typeof tag === 'string') return null;
    if (!out.some((t) => t.key === tag.key)) out.push(tag);
  }
  return out.map((t) => t.name);
}

/** The pinned list as stored, names (or the keys stored before 1.21.0). */
export const storedPins = (profile: Item): string[] =>
  Array.isArray(profile.pinned_tags) ? profile.pinned_tags.map(String) : [];

/** The pinned tags, keys and names, in their order. */
export const pinsOf = (profile: Item): Tag[] => storedPins(profile).map((name) => ({ key: tagKey(name), name }));

export interface TagRowStore {
  tagsBetween(user: string, first: string, last: string): Promise<Item[]>;
}

export interface TagRow {
  /** Keys, as before 1.21.0; pinned_names are their names, one each. */
  pinned: string[];
  pinned_names: string[];
  recent: { tag: string; name: string; count: number; last_used: Day }[];
  window_days: number;
}

export async function tagRow(store: TagRowStore, user: string, profile: Item, today: Day): Promise<TagRow> {
  const pins = pinsOf(profile),
    pinned = pins.map((t) => t.key),
    seen = new Map<string, { name: string; count: number; last: Day }>();
  for (const row of await store.tagsBetween(user, addDays(today, 1 - RECENT_DAYS), today)) {
    const day = String(row.sk).split('#')[1]!;
    for (const tag of storedTags(row)) {
      const was = seen.get(tag.key),
        // The spelling of its latest use (docs/TAGS.md).
        later = !was || day >= was.last;
      seen.set(tag.key, {
        name: later ? tag.name : was.name,
        count: (was?.count ?? 0) + 1,
        last: later ? day : was.last
      });
    }
  }
  const recent = [...seen]
    .filter(([tag]) => !pinned.includes(tag))
    .sort(([a, x], [b, y]) => y.count - x.count || y.last.localeCompare(x.last) || a.localeCompare(b))
    .slice(0, RECENT_MAX)
    .map(([tag, { name, count, last }]) => ({ tag, name, count, last_used: last }));
  return { pinned, pinned_names: pins.map((t) => t.name), recent, window_days: RECENT_DAYS };
}
