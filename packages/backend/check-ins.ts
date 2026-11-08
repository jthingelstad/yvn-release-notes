/** Reading stays (domain/check-ins.ts): check-ins grouped as lists show them,
 * for `GET /v1/check-ins`, MCP and the writes that change a whole stay. */
import {
  checkInCursor,
  checkInKey,
  continues,
  hiddenStay,
  placeOfStay,
  type CheckIn,
  type NamedPlace
} from '../domain/check-ins.ts';

export interface CheckInReads {
  namedPlaces(user: string): Promise<NamedPlace[]>;
  checkInsBelow(user: string, before: string | undefined, limit: number): Promise<{ items: CheckIn[]; more: boolean }>;
  laterInStay(user: string, item: CheckIn, places: readonly NamedPlace[]): Promise<CheckIn[]>;
}

const cursorOf = (item: CheckIn) => checkInCursor(checkInKey(item.at, item.id));
const PAGE = 100;

/** The whole stay this check-in is part of, oldest first. */
export async function stayOf(
  store: CheckInReads,
  user: string,
  item: CheckIn,
  places: readonly NamedPlace[]
): Promise<CheckIn[]> {
  const members = [item];
  back: for (;;) {
    const page = await store.checkInsBelow(user, cursorOf(members[0]!), 20);
    for (const earlier of page.items) {
      if (!continues(earlier, members[0]!, places)) break back;
      members.unshift(earlier);
    }
    if (!page.more) break;
  }
  return [...members, ...(await store.laterInStay(user, item, places))];
}

/** A page of stays, newest first: below `before` (a cursor, or an ISO time),
 * each beginning at `floor` or later, with where the next page starts. A stay
 * goes by when it began, so one that began before `floor` is on an earlier day.
 * Stays at an ignored place are left out, unless `hidden` asks for them. */
export async function stayPage(
  store: CheckInReads,
  user: string,
  o: { before?: string; floor?: string; limit: number; hidden?: boolean }
): Promise<{ stays: CheckIn[][]; next: string | null; places: NamedPlace[] }> {
  const places = await store.namedPlaces(user),
    stays: CheckIn[][] = [],
    under = (at: string) => o.floor !== undefined && at < o.floor,
    shown = (members: CheckIn[]) => o.hidden === true || !hiddenStay(members, places);
  let cursor = o.before,
    current: CheckIn[] | null = null,
    next: string | null = null;
  scan: for (;;) {
    const page = await store.checkInsBelow(user, cursor, PAGE);
    for (const item of page.items) {
      if (current && continues(item, current[0]!, places)) {
        current.unshift(item);
        continue;
      }
      if (current) {
        if (under(current[0]!.at)) {
          current = null;
          break scan;
        }
        if (shown(current)) stays.push(current);
        current = null;
        if (stays.length === o.limit) {
          if (!under(item.at)) next = cursorOf(stays.at(-1)![0]!);
          break scan;
        }
      }
      current = [item];
    }
    if (!page.more) break;
    cursor = cursorOf(page.items.at(-1)!);
  }
  if (current && !under(current[0]!.at) && shown(current)) stays.push(current);
  // The newest stay can run on above where this page began.
  const top = stays[0];
  if (top && o.before !== undefined) top.push(...(await store.laterInStay(user, top.at(-1)!, places)));
  return { stays, next, places };
}

/** Every stay, newest first, for the web's Map. Read whole, as its pins are.
 * `hidden` keeps the stays at ignored places too. */
export async function everyStay(
  store: CheckInReads,
  user: string,
  hidden = false
): Promise<{ stays: CheckIn[][]; places: NamedPlace[] }> {
  const stays: CheckIn[][] = [];
  let before: string | undefined;
  for (;;) {
    const page = await stayPage(store, user, { ...(before === undefined ? {} : { before }), limit: 500, hidden });
    stays.push(...page.stays);
    if (!page.next) return { stays, places: page.places };
    before = page.next;
  }
}

/** Every stay at one remembered place, hidden or not, newest first: what
 * "Delete existing check-ins here" counts and deletes. */
export async function staysAt(
  store: CheckInReads,
  user: string,
  place: string
): Promise<{ stays: CheckIn[][]; places: NamedPlace[] }> {
  const { stays, places } = await everyStay(store, user, true);
  return { stays: stays.filter((members) => placeOfStay(members, places)?.id === place), places };
}
