/** Check-ins on the web (docs/CHECK-INS.md): the owner's session reads, names
 * and deletes them, whichever phone sent them. Each write proves the session
 * and the account in its transaction (guarded-store.ts). A spot or a name goes
 * in no log and no activity row. */
import { randomUUID } from 'node:crypto';
import { eventId, recordActivity } from '../../packages/backend/activity.ts';
import { everyStay, stayOf } from '../../packages/backend/check-ins.ts';
import { reject, type SessionService } from '../../packages/backend/sessions.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import {
  NAMED_PLACES_MAX,
  NAMED_PLACE_SPOTS_MAX,
  SAME_PLACE_METRES,
  STAY_WRITE_MAX,
  checkInKeyOf,
  checkInName,
  metres,
  namedPlaceKey,
  namedPlaceView,
  sameName,
  stayRevision,
  stayView,
  type CheckIn,
  type NamedPlace,
  type Spot
} from '../../packages/domain/check-ins.ts';
import { computeVersion, releaseName } from '../../packages/domain/version.ts';
import { body, json } from './requests.ts';

/** The spots a place needs to hold a whole stay, so remembering it can't split
 * the stay: its own, and each member's that none of them is near. */
export function spotsFor(have: readonly Spot[], members: readonly Spot[]): Spot[] {
  const spots = [...have];
  for (const { lat, lon } of members)
    if (!spots.some((spot) => metres(spot, { lat, lon }) <= SAME_PLACE_METRES)) spots.push({ lat, lon });
  return spots;
}

/** How far the nearest of these spots is: Infinity if there are none. */
const nearestOf = (spot: Spot, spots: readonly Spot[]) => Math.min(...spots.map((other) => metres(spot, other)));

export async function checkInRoutes(
  service: SessionService,
  pattern: string,
  args: string[]
): Promise<Response | null> {
  if (!pattern.startsWith('/api/check-ins')) return null;
  const { uid, profile } = await service.account(),
    ctx = service.context,
    store = ctx.store,
    method = service.request.method,
    log = (fields: Parameters<typeof service.log>[0]) => service.log(fields),
    // What a stay reads as here, with the release its day falls in.
    shown = (members: readonly CheckIn[], places: readonly NamedPlace[]) => {
      const version = computeVersion(String(profile.birthday), String(members[0]!.day));
      return {
        ...stayView(members, places),
        // A stop with no zone of its own reads in the account's.
        time_zone: members[0]!.time_zone ?? profile.tz,
        release: releaseName(version.age),
        version: version.toString()
      };
    },
    note = (kind: string, fields: Item) =>
      recordActivity(store, uid, ctx.now, [{ kind, id: eventId(), fields: { via: 'web', ...fields } }], log);

  if (pattern === '/api/check-ins') {
    if (method === 'GET') {
      const { stays, places } = await everyStay(store, uid);
      return json({ stays: stays.map((members) => shown(members, places)) });
    }
    if ((await body(service.request)).confirm !== 'all') reject(400, 'check-in-confirm');
    const every: CheckIn[] = [];
    for (let before: string | undefined; ;) {
      const page = await store.checkInsBelow(uid, before, 500);
      every.push(...page.items);
      if (!page.more) break;
      before = String(every.at(-1)!.sk).slice('CHECKIN#'.length);
    }
    if (
      !(await store.checkInWrites(
        uid,
        every.map((old) => ({ old })),
        [],
        []
      ))
    )
      reject(409, 'check-in-changed');
    if (every.length) await note('checkin.deleted', { count: every.length, all: true });
    return json({ deleted: every.length });
  }

  if (pattern === '/api/check-ins/places') {
    const places = await store.namedPlaces(uid);
    return json({ places: [...places].sort((a, b) => a.name.localeCompare(b.name)).map(namedPlaceView) });
  }

  if (pattern === '/api/check-ins/places/{id}') {
    const places = await store.namedPlaces(uid),
      old = places.find((place) => place.id === args[0]);
    if (!old) reject(404, 'check-in-place-missing');
    let next: Item | undefined;
    if (method === 'PUT') {
      const given = checkInName((await body(service.request)).name);
      if (!given) reject(400, 'check-in-name');
      if (places.some((place) => place.id !== old.id && sameName(place.name, given)))
        reject(409, 'check-in-place-taken');
      next = { ...old, name: given, revision: Number(old.revision) + 1 };
    }
    if (!(await store.checkInWrites(uid, [{ ...(next ? { next } : {}), old }], [], [])))
      reject(409, 'check-in-changed');
    await note('checkin.place', { place: old.id, change: next ? 'renamed' : 'forgotten' });
    return next ? json({ place: namedPlaceView(next as NamedPlace) }) : new Response(null, { status: 204 });
  }

  // One check-in stands for its whole stay: any id in it names the stay.
  const sk = checkInKeyOf(args[0]!),
    item = sk ? ((await store.mcpGet('USER#' + uid, sk)) as CheckIn | null) : null;
  if (!item) reject(404, 'check-in-missing');
  const places = await store.namedPlaces(uid),
    members = await stayOf(store, uid, item, places);
  if (method === 'GET') return json({ check_in: shown(members, places) });
  if (method === 'DELETE') {
    if (
      !(await store.checkInWrites(
        uid,
        members.map((old) => ({ old })),
        [],
        []
      ))
    )
      reject(409, 'check-in-changed');
    await note('checkin.deleted', { day: members[0]!.day, count: members.length });
    return new Response(null, { status: 204 });
  }

  const value = await body(service.request),
    given = value.name === null ? null : checkInName(value.name);
  if (value.name !== null && !given) reject(400, 'check-in-name');
  if (value.revision !== stayRevision(members)) reject(409, 'check-in-changed');
  const remember = value.remember === true;
  if (remember && !given) reject(400, 'check-in-name');
  const clear = (m: CheckIn, name: string | null) => ({ ...m, name, revision: Number(m.revision) + 1 });
  if (remember) {
    // The name goes on the place, so this stop's own name comes off, or it
    // would keep outranking the place from here on (but see the tie below).
    const old = places.find((place) => sameName(place.name, given!));
    if (!old && places.length >= NAMED_PLACES_MAX) reject(400, 'check-in-places-full');
    const others = places.filter((other) => other.id !== old?.id).flatMap((other) => other.spots),
      spots = spotsFor(old?.spots ?? [], members);
    // Saving a name has to show it. Where another place is as near or nearer,
    // this one takes the member's own spot, and a tie (the other place has that
    // very spot) leaves the stay its own name, which outranks them both.
    for (const { lat, lon } of members) {
      const mine = nearestOf({ lat, lon }, spots);
      if (mine > 0 && mine >= nearestOf({ lat, lon }, others)) spots.push({ lat, lon });
    }
    if (spots.length > NAMED_PLACE_SPOTS_MAX) reject(400, 'check-in-spots-full');
    const own = members.some((m) => nearestOf(m, spots) >= nearestOf(m, others)) ? given : null;
    const grew = spots.length > (old?.spots.length ?? 0),
      id = old?.id ?? `p-${randomUUID().replace(/-/g, '')}`,
      place = (
        old
          ? { ...old, spots, revision: Number(old.revision) + 1 }
          : { pk: 'USER#' + uid, sk: namedPlaceKey(id), id, name: given!, spots, revision: 1 }
      ) as NamedPlace,
      named = members.filter((m) => (m.name ?? null) !== own),
      changes = [
        ...(grew ? [{ next: place, ...(old ? { old } : {}) }] : []),
        ...named.map((m) => ({ next: clear(m, own), old: m }))
      ];
    if (changes.length > STAY_WRITE_MAX) reject(400, 'check-in-stay-long');
    if (!(await store.checkInWrites(uid, changes, [], []))) reject(409, 'check-in-changed');
    if (grew) await note('checkin.place', { place: id, change: old ? 'spot' : 'added' });
    else if (named.length) await note('checkin.named', { checkin: members[0]!.id, day: members[0]!.day });
    return json({
      check_in: shown(
        members.map((m) => ((m.name ?? null) !== own ? clear(m, own) : m)),
        [...places.filter((other) => other.id !== id), grew ? place : (old ?? place)]
      )
    });
  }
  // Naming lands whole, or the stay would split on the way.
  if (members.length > STAY_WRITE_MAX) reject(400, 'check-in-stay-long');
  const named = members.map((m) => clear(m, given));
  if (
    !(await store.checkInWrites(
      uid,
      members.map((old, i) => ({ next: named[i]!, old })),
      [],
      []
    ))
  )
    reject(409, 'check-in-changed');
  await note('checkin.named', { checkin: members[0]!.id, day: members[0]!.day });
  return json({ check_in: shown(named, places) });
}
