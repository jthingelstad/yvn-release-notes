/** Check-ins (docs/CHECK-INS.md): the places an account stopped, as a phone
 * reported them or its owner tapped. A check-in is not a note. It touches no
 * streak, count, badge or note search, and a spot or a name goes neither into
 * the logs nor into a stored activity row.
 *
 * USER#<owner> / CHECKIN#<at>#<id> is one report, `at` being when it began: its
 * arrival, else its departure, else when the server heard it. The id carries
 * `at`, so an id alone finds the item.
 * USER#<owner> / NAMEDPLACE#<id> is a remembered place: a `name`, its
 * `spots`, and `ignored` when its owner ignores it (Jamie, 2026-11-08): no
 * stop there is kept from then on, and those kept already are hidden, not
 * deleted, until it is unignored.
 *
 * Everything shown is worked out when read, so remembering a name applies at
 * once to every stop there, and the merge rule can change without touching
 * data. */
import { codePointLength } from './unicode.ts';

export const CHECKIN = 'CHECKIN#';
/** Above every check-in key ('$' follows '#'). */
export const CHECKIN_END = 'CHECKIN$';
export const NAMED_PLACE = 'NAMEDPLACE#';

/** How near counts as the same place, one number everywhere (Jamie's call 10). */
export const SAME_PLACE_METRES = 100;
/** A stop that begins this soon after the last one ended can merge with it. */
export const MERGE_GAP_SECONDS = 30 * 60;
/** Remembered names an account has, read whole on each join. */
export const NAMED_PLACES_MAX = 200;
/** Spots one name holds, so its item stays small. */
export const NAMED_PLACE_SPOTS_MAX = 50;
export const CHECKIN_NAME_MAX = 100;
/** The check-ins one transaction changes, with room for its proofs and receipt. */
export const STAY_WRITE_MAX = 90;
/** What a stop shows with no name and no neighbourhood. */
export const UNNAMED_STOP = 'Unnamed stop';
export const CHECKIN_SOURCES = ['visit', 'tap'] as const;
/** How a stop's shown name was reached. */
export const NAMED_BY = ['own', 'place', 'district', 'none'] as const;

type Row = Record<string, unknown>;
export interface Spot {
  lat: number;
  lon: number;
}
export interface NamedPlace extends Row {
  id: string;
  name: string;
  spots: Spot[];
  /** Ignored: no stop is kept here, and those kept already are hidden. */
  ignored?: boolean;
  revision?: number;
}
/** A check-in's stored fields. */
export interface CheckIn extends Row {
  sk?: string;
  id: string;
  at: string;
  arrived: string | null;
  left: string | null;
  lat: number;
  lon: number;
  source: string;
  name?: string | null;
  district?: string | null;
}
export interface ShownName {
  label: string;
  named_by: (typeof NAMED_BY)[number];
  /** The remembered place it matched, if that named it. */
  place: string | null;
}

export const checkInKey = (at: string, id: string): string => `${CHECKIN}${at}#${id}`;
/** Where a page of older check-ins starts: a key without its prefix. */
export const checkInCursor = (sk: string): string => sk.slice(CHECKIN.length);
/** An id for a stop beginning at `at`, with the random part it's handed. */
export const checkInId = (at: string, random: string): string => `c${Date.parse(at)}-${random}`;
/** The key an id names, or null if it isn't one. */
export function checkInKeyOf(id: string): string | null {
  const millis = /^c(-?\d{1,16})-[0-9a-f]+$/.exec(id)?.[1],
    at = millis === undefined ? null : new Date(Number(millis));
  return at && Number.isFinite(at.getTime()) ? checkInKey(at.toISOString(), id) : null;
}
export const namedPlaceKey = (id: string): string => NAMED_PLACE + id;

/** A name as it's kept: one line, trimmed, or null if it can't be one. */
export function checkInName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim();
  if (!name || codePointLength(name) > CHECKIN_NAME_MAX || /[\p{Cc}\u2028\u2029]/u.test(name)) return null;
  return name;
}
/** Two names the same, ignoring case, as tags are. */
export const sameName = (a: string, b: string): boolean =>
  a.normalize('NFC').toLocaleLowerCase('en-US') === b.normalize('NFC').toLocaleLowerCase('en-US');

const RADIANS = Math.PI / 180,
  EARTH_METRES = 6_371_000;
/** Metres between two spots, along the ground. */
export function metres(a: Spot, b: Spot): number {
  const dLat = (b.lat - a.lat) * RADIANS,
    dLon = (b.lon - a.lon) * RADIANS,
    h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RADIANS) * Math.cos(b.lat * RADIANS) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The remembered place nearest a spot, within the same-place distance. */
export function nearestPlace(spot: Spot, places: readonly NamedPlace[]): NamedPlace | null {
  let best: NamedPlace | null = null,
    least = Infinity;
  for (const place of places)
    for (const other of place.spots) {
      const distance = metres(spot, other);
      if (distance <= SAME_PLACE_METRES && distance < least) {
        best = place;
        least = distance;
      }
    }
  return best;
}

/** The ignored place a spot is at, if it is at one: the remembered place
 * nearest it within 100 m, as names a stop, when that one is ignored. */
export function ignoredAt(spot: Spot, places: readonly NamedPlace[]): NamedPlace | null {
  const place = nearestPlace(spot, places);
  return place?.ignored === true ? place : null;
}
/** The remembered place a stay is at: the one nearest where it began, as its
 * spot and its name go by its first check-in. */
export const placeOfStay = (members: readonly CheckIn[], places: readonly NamedPlace[]): NamedPlace | null =>
  nearestPlace(members[0]!, places);
/** Whether a stay is hidden: it is at an ignored place. Hidden stays are
 * left out of every list, the log, the Map and each read of one, and come
 * back when the place is unignored. A stay keeps its neighbours apart all
 * the same, so stays read the same whatever is ignored. */
export const hiddenStay = (members: readonly CheckIn[], places: readonly NamedPlace[]): boolean =>
  placeOfStay(members, places)?.ignored === true;

/** A place with `ignored` set, or taken off when it is false, so an item that
 * was never ignored keeps no flag. */
export function withIgnored<T extends NamedPlace>(place: T, ignored: boolean): T {
  const next = { ...place };
  if (ignored) next.ignored = true;
  else delete next.ignored;
  return next;
}

/** The name a check-in shows, first match wins: its own, a remembered place's,
 * its neighbourhood, "Unnamed stop". */
export function shownName(item: CheckIn, places: readonly NamedPlace[]): ShownName {
  if (item.name) return { label: item.name, named_by: 'own', place: null };
  const place = nearestPlace(item, places);
  if (place) return { label: place.name, named_by: 'place', place: place.id };
  if (item.district) return { label: item.district, named_by: 'district', place: null };
  return { label: UNNAMED_STOP, named_by: 'none', place: null };
}

const seconds = (at: string): number => Date.parse(at) / 1000;

/** Whether `later`, the check-in straight after `earlier`, is the same stay.
 * It begins within 30 minutes of the other ending, any own names are the same,
 * and they are within 100 m or at the same remembered place. A short gap alone
 * says nothing: two real shops can be a minute apart. A name given to a merged
 * stay goes on every check-in in it, so its stay holds together. */
export function continues(earlier: CheckIn, later: CheckIn, places: readonly NamedPlace[]): boolean {
  const ended = seconds(earlier.left ?? earlier.at);
  if (seconds(later.at) - ended > MERGE_GAP_SECONDS) return false;
  const own = earlier.name ?? null;
  if (own !== (later.name ?? null)) return false;
  if (metres(earlier, later) <= SAME_PLACE_METRES) return true;
  const here = nearestPlace(earlier, places);
  return Boolean(here && nearestPlace(later, places)?.id === here.id);
}

/** One row of a list: check-ins that read as one stop, oldest first. */
export interface Stay {
  members: CheckIn[];
}
/** The stay as one record: the first one's spot, from its arrival to the last
 * one's leaving. Still there if the last of them is an open visit nothing has
 * left after: two tokens can report one stop, and only one hear of its end. */
export function stayTimes(members: readonly CheckIn[]): { arrived: string | null; left: string | null } {
  const last = members.at(-1)!,
    lefts = members.map((m) => m.left).filter((left): left is string => left !== null),
    latest = lefts.length ? lefts.reduce((a, b) => (a > b ? a : b)) : null,
    open = last.source !== 'tap' && last.left === null && (latest === null || latest <= last.at);
  return { arrived: members[0]!.arrived, left: open ? null : latest };
}
/** A stay's revision, read back to change it: the sum of its check-ins', so
 * it moves when any of them changes, or one joins or goes. */
export const stayRevision = (members: readonly CheckIn[]): number =>
  members.reduce((sum, m) => sum + Number(m.revision ?? 1), 0);

/** What a stay reads as, spot and all, for the account and the tokens and
 * assistants that may read where it has been. */
export function stayView(members: readonly CheckIn[], places: readonly NamedPlace[]): Row {
  const head = members[0]!,
    named = shownName(head, places);
  return {
    id: head.id,
    ids: members.map((m) => m.id),
    at: head.at,
    ...stayTimes(members),
    lat: head.lat,
    lon: head.lon,
    accuracy_m: head.accuracy_m ?? null,
    time_zone: head.time_zone ?? null,
    day: head.day,
    source: head.source,
    label: named.label,
    named_by: named.named_by,
    place: named.place,
    name: head.name ?? null,
    district: head.district ?? null,
    via: head.via ?? null,
    token: head.token ?? null,
    token_id: head.token_id ?? null,
    client: head.client ?? null,
    revision: stayRevision(members)
  };
}
export const namedPlaceView = (place: NamedPlace): Row => ({
  id: place.id,
  name: place.name,
  spots: place.spots,
  ignored: place.ignored === true,
  revision: Number(place.revision ?? 1)
});

/** A stay as an activity row (domain/activity.ts): when and what it showed,
 * and never its spot. Worked out when read, nothing about it is stored. */
export function stayRow(members: readonly CheckIn[], places: readonly NamedPlace[]): Row {
  const head = members[0]!,
    { arrived, left } = stayTimes(members);
  return {
    pk: head.pk,
    sk: `ACTIVITY#${head.at}#checkin#${head.id}`,
    kind: 'checkin',
    at: head.at,
    checkin: head.id,
    label: shownName(head, places).label,
    arrived,
    left,
    source: head.source,
    day: head.day,
    ...(head.time_zone ? { time_zone: head.time_zone } : {}),
    ...(members.length > 1 ? { merged: members.length } : {}),
    ...(head.via ? { via: head.via } : {}),
    ...(head.token ? { token: head.token } : {}),
    ...(head.token_id ? { token_id: head.token_id } : {}),
    ...(head.client ? { client: head.client } : {})
  };
}
