/** Reading stays (domain/check-ins.ts): check-ins grouped as lists show them,
 * for `GET /v1/check-ins`, MCP and the writes that change a whole stay. */
import { checkInCursor, checkInKey, continues, type CheckIn, type NamedPlace } from '../domain/check-ins.ts';

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
 * goes by when it began, so one that began before `floor` is on an earlier day. */
export async function stayPage(
  store: CheckInReads,
  user: string,
  o: { before?: string; floor?: string; limit: number }
): Promise<{ stays: CheckIn[][]; next: string | null; places: NamedPlace[] }> {
  const places = await store.namedPlaces(user),
    stays: CheckIn[][] = [],
    under = (at: string) => o.floor !== undefined && at < o.floor;
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
        stays.push(current);
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
  if (current && !under(current[0]!.at)) stays.push(current);
  // The newest stay can run on above where this page began.
  const top = stays[0];
  if (top && o.before !== undefined) top.push(...(await store.laterInStay(user, top.at(-1)!, places)));
  return { stays, next, places };
}
