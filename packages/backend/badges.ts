/** One subscriber's badge facts, for `evaluateBadges` (docs/BADGES.md): their
 * NOTE# rows read whole, as search reads them, plus WEATHER#, PAUSE# and the
 * profile. A note's text is used in memory for its word count only, never
 * kept or logged. A reply to a daily email keeps its `subject` (empty or not)
 * and a note to the standing address never has one, which tells them apart.
 * The export works the same facts out of the rows it already holds. Giving
 * years come from the profile's `giving` (domain/giving.ts). The firsts
 * earned outside notes and the Roadmap (domain/badges.ts, `BadgeEvent`) come
 * from three more reads: the activity rows `Store.badgeActivity` narrows to,
 * FEEDBACK# and UPCOMING#. A failed one leaves its events out, logged as
 * badge-facts-partial with the user id and which read, and never fails
 * badges; a save then claims none of the badges events earn, so a row is
 * never written for one already had. */
import type { Store, Item } from './store.ts';
import { safeLog, type Log } from './services.ts';
import { iso, localDay, validTimezone, type Day } from '../domain/dates.ts';
import { activityTime, type ActivityEvent } from '../domain/activity.ts';
import { badgeEvents } from './activity.ts';
import type { UpcomingChange } from './upcoming.ts';
import { writtenAt, type NoteRecord, type PlaceRecord } from '../domain/notes.ts';
import { pauseDays } from '../domain/streak.ts';
import { givingYears } from '../domain/giving.ts';
import { feedbackItem } from '../domain/feedback.ts';
import {
  badgeEventsOf,
  evaluateBadges,
  unlocked,
  weekEnd,
  EVENT_BADGES,
  type BadgeEvent,
  type BadgeEventKind,
  type BadgeFacts,
  type BadgeNote,
  type Badges,
  type Unlocked,
  upcomingEventKey
} from '../domain/badges.ts';

/** The reads badges take: the full Store, or the MCP reader's narrower one. */
export type BadgeStore = Pick<
  Store,
  'allNotes' | 'pauses' | 'weatherBetween' | 'badgeActivity' | 'feedbackItems' | 'upcomingEntries'
>;
export interface FactOptions {
  /** Leave out one note (its sort key), to see the rest without it. */
  except?: string;
  /** Read what was just written (a saved note, its weather). */
  consistent?: boolean;
  log?: Log;
}
/** The facts, and whether a read of the events failed. */
export type Facts = BadgeFacts & { partial: boolean };

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

export async function badgeFacts(
  store: BadgeStore,
  user: string,
  profile: Item,
  today: Day,
  o: FactOptions = {}
): Promise<Facts> {
  const birthday = String(profile.birthday),
    consistent = o.consistent ?? false,
    [notes, pauses, weather, ...extra] = await Promise.all([
      store.allNotes(user, consistent),
      store.pauses(user, consistent),
      store.weatherBetween(user, birthday, today, consistent),
      ...[
        () => store.badgeActivity(user, consistent),
        () => store.feedbackItems(user),
        () => store.upcomingEntries(user)
      ].map((read) =>
        read().then(
          (rows) => rows,
          () => null
        )
      )
    ]),
    [activity, feedback, upcoming] = extra as [
      Item[] | null,
      Awaited<ReturnType<Store['feedbackItems']>> | null,
      Awaited<ReturnType<Store['upcomingEntries']>> | null
    ],
    failed = (['activity', 'feedback', 'upcoming'] as const).filter((_, i) => extra[i] === null);
  if (failed.length) (o.log ?? safeLog)({ event: 'badge-facts-partial', user, failed: failed.join(',') });
  return {
    birthday,
    ...(profile.country ? { homeCountry: String(profile.country) } : {}),
    notes: notes.filter((n) => n.sk !== o.except).map((n) => badgeNote(n, profile)),
    weather,
    paused: pauseDays(pauses, weekEnd(today)),
    giving: givingYears(profile.giving),
    events: badgeEventsOf(
      {
        ...(activity ? { activity } : {}),
        ...(feedback ? { feedback } : {}),
        ...(upcoming ? { upcoming } : {}),
        // A photo whose photo.set row is unknown only because that read failed
        // is not counted again from the profile.
        ...(activity ? { photoAt: photoAt(profile) } : {})
      },
      String(profile.tz)
    ),
    partial: failed.length > 0
  };
}
const photoAt = (profile: Item) =>
  profile.photo && typeof profile.photo === 'object' ? (profile.photo as Item).at : undefined;

export async function badges(store: BadgeStore, user: string, profile: Item, today: Day, log?: Log): Promise<Badges> {
  return evaluateBadges(await badgeFacts(store, user, profile, today, log ? { log } : {}), today);
}

/** What `before` to `after` unlocked; with the events read only in part, never
 * a badge events earn, which the missing rows may already hold. */
function diff(facts: Facts, before: BadgeFacts, after: BadgeFacts, today: Day): Unlocked[] {
  const found = unlocked(evaluateBadges(before, today), evaluateBadges(after, today));
  return facts.partial ? found.filter((u) => !EVENT_BADGES.has(u.id)) : found;
}
/** Leaves out the events named by `fresh`, and the profile's own photo time
 * when a photo is among them (it is that photo). */
const without = (events: readonly BadgeEvent[] | undefined, fresh: readonly BadgeEvent[]) => {
  const keys = new Set(fresh.map((e) => e.key));
  if (fresh.some((e) => e.kind === 'signed')) keys.add('photo');
  return (events ?? []).filter((e) => !keys.has(e.key));
};

/** What saving `note` (a NOTE# row, `sk` included) just earned: the others
 * with it, against the others without it, or with `old` (the note before an
 * edit). Read consistently, so a note saved a moment before and the weather
 * just kept are in both. `fresh` are events the same save made (an agent's
 * edit), in the after alone. */
export async function unlockedBy(
  store: BadgeStore,
  user: string,
  profile: Item,
  today: Day,
  note: Item,
  old?: Item | null,
  fresh: readonly BadgeEvent[] = [],
  log?: Log
): Promise<Unlocked[]> {
  const facts = await badgeFacts(store, user, profile, today, {
      except: String(note.sk),
      consistent: true,
      ...(log ? { log } : {})
    }),
    events = without(facts.events, fresh);
  return diff(
    facts,
    { ...facts, events, notes: old ? [...facts.notes, badgeNote(old, profile)] : facts.notes },
    { ...facts, events: [...events, ...fresh], notes: [...facts.notes, badgeNote(note, profile)] },
    today
  );
}

/** What `fresh` (the events an action outside notes just made: a photo set,
 * feedback filed or marked done, a book asked for, dates added to Upcoming)
 * earned, against the account without them, whether or not their rows are
 * written yet. */
export async function unlockedByEvents(
  store: BadgeStore,
  user: string,
  profile: Item,
  today: Day,
  fresh: readonly BadgeEvent[],
  log?: Log
): Promise<Unlocked[]> {
  if (!fresh.length) return [];
  const facts = await badgeFacts(store, user, profile, today, { consistent: true, ...(log ? { log } : {}) }),
    events = without(facts.events, fresh);
  return diff(facts, { ...facts, events }, { ...facts, events: [...events, ...fresh] }, today);
}

/** An event an action makes now, on the subscriber's local day. */
export function freshEvent(kind: BadgeEventKind, key: string, now: number, tz: unknown): BadgeEvent {
  return {
    kind,
    key,
    at: activityTime(now),
    day: localDay(Math.floor(now), validTimezone(tz) ? String(tz) : 'UTC')
  };
}

/** The Roadmap events a save of Upcoming dates made: one per date added. */
export const addedEvents = (changes: readonly UpcomingChange[], now: number, tz: unknown): BadgeEvent[] =>
  changes
    .filter((c) => !c.previous && c.next)
    .map((c) => freshEvent('upcoming', upcomingEventKey(c.next!.id), now, tz));

/** What an action outside notes earned (`fresh`), for its answer and its
 * badge.earned rows (`via`, `client`), which go in the same write as the
 * action's own row. Never a reason to fail the action: a failed read earns
 * nothing here, is logged as badges-error with the user id, and the email
 * tells of the badge later. `seen` marks them told, for a page that shows
 * the unlock line. Nothing while "Show badges" is off. */
export async function earnedBy(
  store: BadgeStore & Partial<Pick<Store, 'addSeenBadges'>>,
  user: string,
  profile: Item,
  now: number,
  fresh: readonly BadgeEvent[],
  o: { via: string; client?: unknown; seen?: boolean; log: Log }
): Promise<{ unlocked: Unlocked[]; events: ActivityEvent[] }> {
  if (profile.badges === false || !fresh.length) return { unlocked: [], events: [] };
  let found: Unlocked[];
  try {
    const tz = validTimezone(profile.tz) ? String(profile.tz) : 'UTC';
    found = (await unlockedByEvents(store, user, profile, localDay(Math.floor(now), tz), fresh, o.log)).filter(
      (u) => !u.album
    );
  } catch {
    o.log({ event: 'badges-error', user });
    return { unlocked: [], events: [] };
  }
  if (o.seen && found.length && store.addSeenBadges)
    try {
      await store.addSeenBadges(
        user,
        found.map((u) => u.key),
        iso(now)
      );
    } catch {
      // Not seen yet, so the email tells of it as well; the rows still go.
      o.log({ event: 'badges-error', user });
    }
  return { unlocked: found, events: badgeEvents(found, o.via, null, null, o.client) };
}

/** The same facts from a person's rows already in hand (the export's):
 * `profile` is the PROFILE row as stored. */
export function badgesOf(items: readonly Item[], profile: Item, today: Day): Badges {
  const birthday = String(profile.birthday),
    notes: BadgeNote[] = [],
    weather: BadgeFacts['weather'] = {},
    pauses: [Day, Day][] = [],
    activity: Item[] = [],
    feedback: ReturnType<typeof feedbackItem>[] = [],
    upcoming: Item[] = [];
  for (const item of items) {
    const sk = String(item.sk);
    if (sk.startsWith('NOTE#')) notes.push(badgeNote(item, profile));
    else if (sk.startsWith('WEATHER#') && sk.slice(8) >= birthday && sk.slice(8) <= today)
      (weather as Record<Day, Item>)[sk.slice(8)] = { high_c: item.high_c, code: item.code };
    else if (sk.startsWith('PAUSE#') && typeof item.through === 'string') pauses.push([sk.slice(6), item.through]);
    else if (sk.startsWith('ACTIVITY#')) activity.push(item);
    else if (sk.startsWith('FEEDBACK#')) feedback.push(feedbackItem(item));
    else if (sk.startsWith('UPCOMING#')) upcoming.push({ id: sk.slice(9), created_at: item.created_at });
  }
  return evaluateBadges(
    {
      birthday,
      ...(profile.country ? { homeCountry: String(profile.country) } : {}),
      notes,
      weather,
      paused: pauseDays(pauses, weekEnd(today)),
      giving: givingYears(profile.giving),
      events: badgeEventsOf(
        { activity, feedback, upcoming: upcoming as { id: string; created_at?: unknown }[], photoAt: photoAt(profile) },
        String(profile.tz)
      )
    },
    today
  );
}
