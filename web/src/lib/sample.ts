// The front page's sample email (components/tour.tsx) and the birthday a
// link can carry to it.
//
// Before a birthday is typed the sample is a made-up morning at 5.2.113.
// Once one is typed it is drawn again in this browser with the visitor's
// own number, from the /api/sample answer the page already has: their
// version, the day it is for them, the same patch in their two releases
// before this one (On this day) and when their next release ships. No other
// request is made and nothing more is kept. The notes, the weather and the
// streak stay made up. The arithmetic is the domain's, the same the email
// uses (packages/mail/compose.ts), so the sample reads as the email would.
//
// yourversionnumber.com links the front page as /#birthday=YYYY-MM-DD
// (Jamie's call 2, 2026-10-29). A fragment never reaches a server, and the
// page counts send the path alone (lib/pagecount.ts). Home reads it as it
// opens, then clears it with history.replaceState.
import { addDays, anniversary, daysBetween, parseDay, validDay } from '../../../packages/domain/dates.ts';
import { computeVersion, sameDayBefore } from '../../../packages/domain/version.ts';
import type { Sample } from './types.ts';

export interface Morning {
  version: string;
  // The day the email is for, an ISO date.
  day: string;
  // The next release and when it ships, as the email says it.
  next: string;
  ships: string;
  // The same patch in the two newest earlier releases that reached it,
  // newest first, as On this day lists them: a release of 365 days never
  // reached patch 365, and a first release has none before it.
  past: string[];
  // Drawn from the visitor's birthday, not made up.
  own: boolean;
}

// The earliest birthday /api/sample takes.
const EARLIEST = '1900-01-01';

function morning(birthday: string, day: string, own: boolean): Morning {
  const v = computeVersion(birthday, day),
    born = parseDay(birthday),
    next = anniversary(born.year + v.age + 1, born.month, born.day);
  return {
    version: v.toString(),
    day,
    next: `${Math.floor((v.age + 1) / 10)}.${(v.age + 1) % 10}.0`,
    ships: daysBetween(day, next) === 1 ? 'tomorrow' : `in ${daysBetween(day, next)} days`,
    past: sameDayBefore(birthday, day)
      .slice(0, 2)
      .map((d) => computeVersion(birthday, d).toString()),
    own
  };
}

// The made-up morning: someone born on 6 July 1974, on Tuesday, 27 October
// 2026. Always the same, so front.html never changes by itself.
export const MADE_UP: Morning = morning('1974-07-06', '2026-10-27', false);

// The visitor's own morning, from their birthday and the /api/sample answer
// for it. Their day is the answer's, the next release less the days to it,
// so it is the day in the zone the page asked in. Null if the answer
// doesn't add up, and the page keeps the made-up morning.
export function ownMorning(birthday: string, s: Sample): Morning | null {
  try {
    if (!validDay(birthday) || !validDay(s.next.date) || !Number.isInteger(s.next.days)) return null;
    const m = morning(birthday, addDays(s.next.date, -s.next.days), true);
    return m.version === s.version && m.next === s.next.version ? m : null;
  } catch {
    return null;
  }
}

// "Tuesday, October 27", as the email dates itself.
export const emailDate = (day: string) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${day}T12:00:00Z`)
  );

// A front page address's fragment, with or without its '#', that carries a
// birthday at all (it is cleared, used or not).
export const carriesBirthday = (hash: string) => /^#?birthday=/.test(hash);

// The birthday in `#birthday=YYYY-MM-DD`, or null. Strict: that one field
// and nothing else, a real calendar day (29 February only in a leap year),
// no earlier than the API takes and not after `today`, the visitor's own
// date. Anything else is ignored, without a word.
export function birthdayFromHash(hash: string, today: string): string | null {
  const m = /^#?birthday=(\d{4}-\d{2}-\d{2})$/.exec(hash);
  const b = m?.[1];
  return b && validDay(b) && b >= EARLIEST && b <= today ? b : null;
}
