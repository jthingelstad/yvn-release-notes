/** The tag row (docs/API.md, Tags; Jamie, 2026-10-29: "Pinned tags are good
 * and then also augmented with frequently used RECENT tags"): the pinned
 * tags (PROFILE.pinned_tags), the same on the web and through every token,
 * then the tags used most in the last 30 days, leaving out pinned ones,
 * ties broken by last use. */
import { addDays, type Day } from '../domain/dates.ts';
import { isTag, tagName } from '../domain/tags.ts';
import type { Item } from './store-types.ts';

export const PINS_MAX = 12,
  RECENT_MAX = 20,
  RECENT_DAYS = 30;

/** A pinned list normalized as note hashtags are ("#Running" is running),
 * each once, in the order given; null when it isn't a list of at most 12
 * tags. */
export function pinnedTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > PINS_MAX) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const tag = tagName(entry.replace(/^#/, ''));
    if (!isTag(tag)) return null;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

export const pinsOf = (profile: Item): string[] =>
  Array.isArray(profile.pinned_tags) ? profile.pinned_tags.map(String) : [];

export interface TagRowStore {
  tagsBetween(user: string, first: string, last: string): Promise<Item[]>;
}

export interface TagRow {
  pinned: string[];
  recent: { tag: string; count: number; last_used: Day }[];
  window_days: number;
}

export async function tagRow(store: TagRowStore, user: string, profile: Item, today: Day): Promise<TagRow> {
  const pinned = pinsOf(profile),
    seen = new Map<string, { count: number; last: Day }>();
  for (const row of await store.tagsBetween(user, addDays(today, 1 - RECENT_DAYS), today)) {
    const day = String(row.sk).split('#')[1]!;
    for (const tag of Array.isArray(row.tags) ? row.tags.map(String) : []) {
      const was = seen.get(tag);
      seen.set(tag, { count: (was?.count ?? 0) + 1, last: was && was.last > day ? was.last : day });
    }
  }
  const recent = [...seen]
    .filter(([tag]) => !pinned.includes(tag))
    .sort(([a, x], [b, y]) => y.count - x.count || y.last.localeCompare(x.last) || a.localeCompare(b))
    .slice(0, RECENT_MAX)
    .map(([tag, { count, last }]) => ({ tag, count, last_used: last }));
  return { pinned, recent, window_days: RECENT_DAYS };
}
