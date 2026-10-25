/** The Weekly Thing: Release Notes comes with a subscription to it.
 *
 * Jamie, 2026-10-25: "I would also like release notes to be framed as better
 * for Weekly Thing supporting members and also gated by subscribing to Weekly
 * Thing." A new account needs its verified address on the Weekly Thing's
 * list; accounts made before the gate keep everything (Jamie: "Keep them").
 * Supporting membership changes only the framing for now (Jamie: "Framing
 * only for now"), and every account's standing is looked at again after
 * `RECHECK_SECONDS`, as Thingy does (Jamie: "Re-check like Thingy").
 *
 * The Librarian answers, the way it answers Thingy (Jamie: "Use the
 * librarians api to see if a member. It should be like Thingy and offer to
 * sign people up directly in release notes."): its public `/auth` takes
 * `check` (status only, nothing mailed) and `subscribe` (Buttondown's
 * confirmation email) for the address this session proved with an emailed
 * code, with `source: release-notes` (librarian-thing's
 * `apps/librarian/AGENTS.md`, "Release Notes asks like Thingy"). The answer
 * is kept on the profile as one word. A lookup that fails never locks anyone
 * out: sign-up goes ahead and a re-check keeps what was known. A lookup that
 * answers `member` also records the year in the profile's `giving`
 * (domain/giving.ts), which earns that year's giving badge.
 */
import { iso, type Day } from '../domain/dates.ts';
import { sawMember } from '../domain/giving.ts';
import type { Item } from './store-types.ts';

export const LIBRARIAN_AUTH = 'https://librarian.thingelstad.com/auth';
const SOURCE = 'release-notes';
/** Nine days, Thingy's `ENTITLEMENT_VERIFICATION_SECONDS`. */
export const RECHECK_SECONDS = 9 * 86_400;
/** Someone who has just asked to be added is waiting on one email, so an
 * unconfirmed standing is looked at again sooner. */
export const UNCONFIRMED_RECHECK_SECONDS = 600;
const CHECK_TIMEOUT_MS = 3000;
const SUBSCRIBE_TIMEOUT_MS = 10_000;

/**
 * member: a Supporting Member (the Librarian's `premium`).
 * reader: on the list and getting issues, a lapsed member included (`active`).
 * unconfirmed: subscribed but not yet confirmed.
 * none: not on the list, gone from it, or held by Buttondown's firewall.
 */
export type Standing = 'member' | 'reader' | 'unconfirmed' | 'none';
export const STANDINGS: readonly Standing[] = ['member', 'reader', 'unconfirmed', 'none'];
/** Standings that may make an account. */
export const welcome = (s: Standing) => s === 'member' || s === 'reader';
/** Whether a profile's standing is due a fresh look: `RECHECK_SECONDS` old,
 * sooner while unconfirmed, or never asked (an account from before the gate). */
export function recheckDue(p: Item, now: number): boolean {
  const at = Date.parse(String(p.weekly_thing_at ?? '')) / 1000,
    every = p.weekly_thing === 'unconfirmed' ? UNCONFIRMED_RECHECK_SECONDS : RECHECK_SECONDS;
  return !Number.isFinite(at) || now - at >= every;
}
/** The profile fields a standing seen at `now` (the account's local `day`)
 * sets: the standing, when, and for a member the year it gave. */
export function standingFields(standing: Standing, now: number, day: Day, p: Item): Item {
  const giving = standing === 'member' ? sawMember(p.giving, day) : null;
  return { weekly_thing: standing, weekly_thing_at: iso(now), ...(giving ? { giving } : {}) };
}

/** How asking to be added ended. `added` means Buttondown sent its
 * confirmation email; `review` that its firewall is holding the address for
 * Jamie; `by-hand` that the list can't take it back automatically. */
export type Subscribed =
  { outcome: 'added' } | { outcome: 'already'; standing: Standing } | { outcome: 'review' | 'by-hand' };

export class LookupError extends Error {
  constructor(readonly status: number) {
    super(`Weekly Thing lookup failed with ${status}`);
    this.name = 'LookupError';
  }
}

/** The Librarian's subscriber status as a standing. */
const FROM_STATUS: Record<string, Standing> = {
  premium: 'member',
  active: 'reader',
  unconfirmed: 'unconfirmed',
  not_found: 'none',
  inactive: 'none'
};

/** What `/auth` `check` answered: 200 with a status, or 403 `inactive` for
 * an address that left or is under review. Anything else is a failure. */
export function standingOf(status: number, body: Record<string, unknown>): Standing {
  const standing = FROM_STATUS[String(body.status ?? '')];
  if (standing && (status === 200 || (status === 403 && body.status === 'inactive'))) return standing;
  throw new LookupError(status);
}

/** What `/auth` `subscribe` answered. Rate limits, Buttondown failures and
 * Turnstile refusals are failures; the reader is asked to try again. */
export function subscribedOf(status: number, body: Record<string, unknown>): Subscribed {
  if (status === 200) {
    if (body.status === 'subscribed') return { outcome: 'added' };
    if (body.status === 'already_subscribed')
      return { outcome: 'already', standing: FROM_STATUS[String(body.subscriber_status)] ?? 'reader' };
    if (body.status === 'needs_jamie') return { outcome: body.subscriber_status === 'blocked' ? 'review' : 'by-hand' };
    if (body.status === 'resubscribe_unavailable') return { outcome: 'by-hand' };
  }
  throw new LookupError(status);
}

export interface WeeklyThing {
  standing(email: string): Promise<Standing>;
  subscribe(email: string): Promise<Subscribed>;
}

/** Asks the Librarian's `/auth`; nothing here holds a key. */
export function createWeeklyThing(url = LIBRARIAN_AUTH, fetcher: typeof fetch = fetch): WeeklyThing {
  const ask = async (fields: Record<string, unknown>, timeout: number) => {
    const r = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ source: SOURCE, ...fields }),
      signal: AbortSignal.timeout(timeout)
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      throw new LookupError(r.status);
    }
    return { status: r.status, body: body && typeof body === 'object' ? (body as Record<string, unknown>) : {} };
  };
  return {
    async standing(email) {
      const { status, body } = await ask({ action: 'check', email }, CHECK_TIMEOUT_MS);
      return standingOf(status, body);
    },
    async subscribe(email) {
      const { status, body } = await ask(
        { action: 'subscribe', email, attribution: { ref: SOURCE } },
        SUBSCRIBE_TIMEOUT_MS
      );
      return subscribedOf(status, body);
    }
  };
}
