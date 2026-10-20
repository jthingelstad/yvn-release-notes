/** One subscriber's badge facts, for `evaluateBadges` (docs/BADGES.md): their
 * NOTE# rows read whole, as search reads them, plus WEATHER#, PAUSE# and the
 * profile. A note's text is used in memory for its word count only, never
 * kept or logged. A reply to a daily email keeps its `subject` (empty or not)
 * and a note to the standing address never has one, which tells them apart.
 * The export works the same facts out of the rows it already holds. */
import type { Store, Item } from './store.ts';
import { localDay, validTimezone, type Day } from '../domain/dates.ts';
import { writtenAt, type NoteRecord, type PlaceRecord } from '../domain/notes.ts';
import { pauseDays } from '../domain/streak.ts';
import {
  evaluateBadges,
  unlocked,
  type BadgeFacts,
  type BadgeNote,
  type Badges,
  type Unlocked
} from '../domain/badges.ts';

export const words = (text: string) => text.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

export function badgeNote(item: Item, profile: Item): BadgeNote {
  const day = String(item.sk).split('#')[1]!,
    at = writtenAt(item as NoteRecord),
    zone = validTimezone(item.tz) ? String(item.tz) : String(profile.tz),
    epoch = Date.parse(at),
    media = Array.isArray(item.media) ? (item.media as Item[]) : [],
    place = (item.place ?? null) as PlaceRecord | null,
    source = String(item.source ?? 'email'),
    city = place?.city || (profile.city as string | undefined),
    country = place?.city ? place.country : (profile.country as string | undefined);
  return {
    day,
    written: Number.isFinite(epoch) ? localDay(Math.floor(epoch / 1000), zone) : day,
    at,
    source,
    reply: source === 'email' && Object.hasOwn(item, 'subject'),
    assistant: item.author === 'assistant',
    words: words(String(item.text ?? '')),
    tags: Array.isArray(item.tags) ? (item.tags as string[]) : [],
    links: Array.isArray(item.links) ? item.links.length : 0,
    photos: media.filter((m) => m.kind === 'image').length,
    audio: media.filter((m) => m.kind === 'audio').length,
    placed: Boolean(place && place.from !== 'home' && (place.city || place.label || place.venue)),
    ...(city ? { city: String(city) } : {}),
    ...(country ? { country: String(country) } : {})
  };
}

/** `except` leaves out one note (its sort key), to see the rest without it. */
export async function badgeFacts(
  store: Store,
  user: string,
  profile: Item,
  today: Day,
  except?: string
): Promise<BadgeFacts> {
  const birthday = String(profile.birthday),
    [notes, pauses, weather] = await Promise.all([
      store.allNotes(user),
      store.pauses(user),
      store.weatherBetween(user, birthday, today)
    ]);
  return {
    birthday,
    ...(profile.country ? { homeCountry: String(profile.country) } : {}),
    notes: notes.filter((n) => n.sk !== except).map((n) => badgeNote(n, profile)),
    weather,
    paused: pauseDays(pauses, today)
  };
}

export async function badges(store: Store, user: string, profile: Item, today: Day): Promise<Badges> {
  return evaluateBadges(await badgeFacts(store, user, profile, today), today);
}

/** What saving `note` (a NOTE# row, `sk` included) just earned. It is read
 * with the others and then without it, so a read that missed the new row
 * still answers the same. */
export async function unlockedBy(
  store: Store,
  user: string,
  profile: Item,
  today: Day,
  note: Item
): Promise<Unlocked[]> {
  const facts = await badgeFacts(store, user, profile, today, String(note.sk));
  return unlocked(
    evaluateBadges(facts, today),
    evaluateBadges({ ...facts, notes: [...facts.notes, badgeNote(note, profile)] }, today)
  );
}

/** The same facts from a person's rows already in hand (the export's). */
export function badgesOf(items: readonly Item[], profile: Item, today: Day): Badges {
  const birthday = String(profile.birthday),
    notes: BadgeNote[] = [],
    weather: BadgeFacts['weather'] = {},
    pauses: [Day, Day][] = [];
  for (const item of items) {
    const sk = String(item.sk);
    if (sk.startsWith('NOTE#')) notes.push(badgeNote(item, profile));
    else if (sk.startsWith('WEATHER#') && sk.slice(8) >= birthday && sk.slice(8) <= today)
      (weather as Record<Day, Item>)[sk.slice(8)] = { high_c: item.high_c, code: item.code };
    else if (sk.startsWith('PAUSE#') && typeof item.through === 'string') pauses.push([sk.slice(6), item.through]);
  }
  return evaluateBadges(
    {
      birthday,
      ...(profile.country ? { homeCountry: String(profile.country) } : {}),
      notes,
      weather,
      paused: pauseDays(pauses, today)
    },
    today
  );
}
