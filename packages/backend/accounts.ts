/** Account settings and deletion stay behind the email-verified session.
 * Deletion blocks MCP first; private objects precede table/profile removal. */
import { photoOf } from './profile-photo.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { SessionService, reject } from './sessions.ts';
import type { Item, Key } from './store-types.ts';
import { chosen, clean, devicePlace, object } from './places.ts';
import { iso, localDay, validDay, addDays, daysBetween } from '../domain/dates.ts';
import { profileView, pauseStart } from './views.ts';
import { validCode, digest, clearCookie } from './auth.ts';
import { keys, thumbKeys } from './media.ts';
import { OAuthService } from './oauth.ts';
import { badges } from './badges.ts';
import { again, eventId, givingEvents, recordActivity } from './activity.ts';
import type { ActivityEvent } from '../domain/activity.ts';
import { sawMember } from '../domain/giving.ts';
import { LookupError, recheckDue, standingFields, welcome, type Standing } from './weekly-thing.ts';
/** The settings a change records, each with what it reads as when unset. */
const SETTINGS: Record<string, unknown> = {
  send_time: null,
  tz: null,
  city: null,
  region: null,
  country: null,
  transcribe: false,
  describe: false,
  badges: true,
  here: true
};
const record = (service: SessionService, user: string, events: ActivityEvent[]) =>
  recordActivity(service.context.store, user, service.context.now, events, (f) => service.log(f));
/** An address's Weekly Thing standing as profile fields
 * (packages/backend/weekly-thing.ts), or nothing when there is no gate or the
 * lookup failed: a failure never locks anyone out. */
export async function lookUpWeeklyThing(
  service: SessionService,
  email: string
): Promise<{ weekly_thing?: Standing; weekly_thing_at?: string }> {
  const lookup = service.context.weeklyThing;
  if (!lookup) return {};
  try {
    const standing = await lookup.standing(email);
    service.log({ event: 'weekly-thing', standing });
    return { weekly_thing: standing, weekly_thing_at: iso(service.context.now) };
  } catch (error) {
    service.log({ event: 'weekly-thing-error', ...(error instanceof LookupError ? { status: error.status } : {}) });
    return {};
  }
}
/** An account's standing, looked up again once it is `RECHECK_SECONDS` old
 * (Jamie, 2026-10-25: "Re-check like Thingy"), sooner while a subscription
 * waits to be confirmed, and on the first visit after a sign-in at
 * `signedInAt` (a session's `created_at`). It changes what the pages say and, for a member,
 * records the year given (domain/giving.ts); a failed lookup keeps what was
 * known and asks again on the next visit. The sender looks again too, after
 * the email (workers/send.ts), for accounts that never open the web. */
export async function recheckWeeklyThing(
  service: SessionService,
  uid: string,
  p: Item,
  signedInAt?: number
): Promise<Item> {
  if (!recheckDue(p, service.context.now, signedInAt)) return p;
  const { weekly_thing } = await lookUpWeeklyThing(service, String(p.email));
  if (!weekly_thing) return p;
  return saveWeeklyThing(service, uid, p, weekly_thing);
}
async function saveWeeklyThing(service: SessionService, uid: string, p: Item, standing: Standing): Promise<Item> {
  const now = service.context.now,
    day = localDay(now, String(p.tz)),
    fields = standingFields(standing, now);
  // The year first: when either write fails, the standing keeps its old
  // time, so the next visit asks again rather than nine days on.
  let added = false,
    saved = true;
  try {
    if (standing === 'member') added = await service.context.store.widenGiving(uid, day, p.giving);
    await service.context.store.updateProfile(uid, fields);
  } catch {
    service.log({ event: 'weekly-thing-save-error', user: uid });
    saved = false;
  }
  await record(service, uid, givingEvents(p, added ? day : null));
  return saved ? { ...p, ...fields } : p;
}
/** Adds the session's verified address to the Weekly Thing, as Thingy offers
 * to (Jamie: "offer to sign people up directly in release notes"). The
 * address is the one this session proved with an emailed code, never one
 * typed here. Answers the standing the pages should show next; an account's
 * profile keeps it. */
export async function subscribeWeeklyThing(service: SessionService): Promise<{ weekly_thing: Standing }> {
  const lookup = service.context.weeklyThing;
  if (!lookup) reject(404, 'weekly-thing-off');
  const s = await service.signedIn(),
    account = s.user_id ? await service.account() : null,
    email = String(account ? account.profile.email : s.email);
  let answer;
  try {
    answer = await lookup.subscribe(email);
  } catch (error) {
    service.log({
      event: 'weekly-thing-subscribe-error',
      ...(error instanceof LookupError ? { status: error.status } : {})
    });
    reject(503, 'weekly-thing-busy');
  }
  service.log({ event: 'weekly-thing-subscribe', outcome: answer.outcome });
  if (answer.outcome === 'review') reject(409, 'weekly-thing-review');
  if (answer.outcome === 'by-hand') reject(409, 'weekly-thing-by-hand');
  const weekly_thing: Standing = answer.outcome === 'already' ? answer.standing : 'unconfirmed';
  if (account) await saveWeeklyThing(service, account.uid, account.profile, weekly_thing);
  return { weekly_thing };
}
export function replyToken(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567',
    bytes = randomBytes(15);
  let bits = 0,
    value = 0,
    out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits -= 5)) & 31];
    }
  }
  return out;
}
/** The longest pause, in days, start day included (the Pause page and the
 * guide say it). */
export const MAX_PAUSE_DAYS = 60;
export const sendTime = (b: Item): string => {
  if (typeof b.send_time !== 'string' || !/^([01][0-9]|2[0-3]):(00|15|30|45)$/.test(b.send_time))
    reject(400, 'send-time');
  return b.send_time;
};
export function chosenPlace(raw: unknown): Item {
  const p = clean(raw);
  if (!p) reject(400, 'place');
  return { ...chosen(p) };
}
/** A note's place: a city from the search, or the spot a device gave
 * ("Here", `POST /api/places/here`), kept exact. */
export function notePlace(raw: unknown): Item {
  if (object(raw)?.from !== 'device') return chosenPlace(raw);
  const p = devicePlace(raw);
  if (!p) reject(400, 'place');
  return p;
}
export function placeFields(b: Item): Item {
  const p = chosenPlace(b.place);
  delete p.from;
  return p;
}
export async function updateAccount(service: SessionService, b: Item): Promise<Item> {
  const s = await service.signedIn(),
    ctx = service.context,
    store = ctx.store;
  if (!s.user_id) {
    const fields = placeFields(b),
      time = sendTime(b),
      today = localDay(ctx.now, String(fields.tz)),
      birthday = b.birthday;
    if (typeof birthday !== 'string' || !validDay(birthday) || birthday < '1900-01-01' || birthday > today)
      reject(400, 'birthday');
    const email = String(s.email);
    // Release Notes comes with the Weekly Thing (weekly-thing.ts).
    const { weekly_thing } = await lookUpWeeklyThing(service, email);
    if (weekly_thing === 'unconfirmed') reject(403, 'weekly-thing-unconfirmed');
    if (weekly_thing && !welcome(weekly_thing)) reject(403, 'weekly-thing');
    // A new profile has no giving to race, so a member's first year goes in whole.
    const member = weekly_thing === 'member',
      standing = weekly_thing
        ? { ...standingFields(weekly_thing, ctx.now), ...(member ? { giving: sawMember(undefined, today) } : {}) }
        : {};
    let uid = randomUUID().replace(/-/g, ''),
      p: Item = { birthday, send_time: time, status: 'active', created_at: iso(ctx.now), ...fields, ...standing };
    if (!(await store.createSubscriberVerified(uid, email, p, String(s.hash), ctx.now, Number(s.expires_at)))) {
      const existing = await store.userForEmail(email);
      if (!existing) reject(409, 'try-again');
      uid = existing;
      p = (await store.profile(uid)) ?? {};
    } else {
      try {
        if (await store.setInbox(uid, replyToken(), iso(ctx.now))) p = (await store.profile(uid)) ?? p;
      } catch {
        service.log({ event: 'inbox-error', user: uid });
      }
      try {
        await ctx.invocations.invoke(ctx.senderFunction, { send_now: uid }, true);
      } catch {
        service.log({ event: 'first-email-failed', user: uid });
      }
      await service.tally('signups');
      await record(service, uid, [
        { kind: 'account.created', id: uid, fields: { via: 'web' } },
        ...givingEvents({ birthday }, member ? today : null)
      ]);
    }
    if (!(await store.claimVerifiedSession(String(s.hash), uid, email, ctx.now, Number(s.expires_at))))
      reject(401, 'signed-out');
    service.log({ event: 'signup', user: uid });
    return profileView({ email, ...p }, ctx.now, ctx.inboundDomain);
  }
  const { uid, profile: p } = await service.account(),
    fields: Item = {};
  if (Object.hasOwn(b, 'birthday') && b.birthday !== p.birthday) reject(400, 'birthday-locked');
  if (Object.hasOwn(b, 'send_time')) fields.send_time = sendTime(b);
  if (Object.hasOwn(b, 'place')) Object.assign(fields, placeFields(b));
  for (const k of ['transcribe', 'describe', 'badges', 'here'])
    if (Object.hasOwn(b, k)) {
      if (typeof b[k] !== 'boolean') reject(400, k);
      fields[k] = b[k];
    }
  // Badges back on show what was earned meanwhile without announcing it
  // (docs/BADGES.md): it all counts as seen first. If that fails, badges stay
  // off and the save fails, or the next email would announce the backlog.
  if (fields.badges === true && p.badges === false)
    try {
      const earned = await badges(ctx.store, uid, p, localDay(ctx.now, String(p.tz)));
      await ctx.store.addSeenBadges(
        uid,
        earned.earned.map((e) => e.key),
        iso(ctx.now)
      );
    } catch {
      service.log({ event: 'badges-error', user: uid });
      reject(503, 'badges-failed');
    }
  if (Object.hasOwn(b, 'status')) {
    if (b.status !== 'active') reject(400, 'status');
    Object.assign(fields, { status: 'active', restarted_at: iso(ctx.now) });
    if (p.status === 'stopped') {
      if (p.stopped_reason === 'bounce' || p.stopped_reason === 'complaint') {
        try {
          await ctx.mail.unsuppress(String(p.email));
        } catch {
          reject(502, 'restart-failed');
        }
      }
      await service.tally('restarts');
    }
  }
  if (!Object.keys(fields).length) reject(400, 'nothing-to-change');
  const remove = fields.status ? ['stopped_reason', 'stopped_at'] : [];
  await ctx.store.updateProfile(uid, fields, remove);
  service.log({ event: 'settings', user: uid });
  const changes = Object.entries(SETTINGS)
    .filter(([k]) => Object.hasOwn(fields, k))
    .map(([field, unset]) => ({ field, from: p[field] ?? unset, to: fields[field] ?? unset }))
    .filter((c) => c.from !== c.to);
  await record(service, uid, [
    ...(changes.length ? [{ kind: 'settings.changed', id: eventId(), fields: { via: 'web', changes } }] : []),
    ...(fields.status && p.status === 'stopped'
      ? [{ kind: 'status.restarted', id: eventId(), fields: { via: 'web', reason: p.stopped_reason ?? null } }]
      : [])
  ]);
  return profileView(
    Object.fromEntries(Object.entries({ ...p, ...fields }).filter(([k]) => !remove.includes(k))),
    ctx.now,
    ctx.inboundDomain
  );
}
export async function changePause(service: SessionService, b: Item | null): Promise<Item> {
  const { uid, profile: p } = await service.account(),
    ctx = service.context,
    today = localDay(ctx.now, String(p.tz));
  if (!b) {
    const start = String(p.pause_from ?? ''),
      through = String(p.pause_through ?? '');
    if (start && through >= today) {
      const ended = addDays(today, -1);
      await ctx.store.endPause(uid, start, start <= ended ? ended : null);
      await record(service, uid, [
        {
          kind: 'pause.ended',
          id: again(start),
          fields: { via: 'web', from: start, through: start <= ended ? ended : null }
        }
      ]);
    }
    delete p.pause_from;
    delete p.pause_through;
    return profileView(p, ctx.now, ctx.inboundDomain);
  }
  if ((p.status ?? 'active') !== 'active') reject(400, 'stopped');
  let start = pauseStart(p, today);
  const current = String(p.pause_through ?? '') >= today ? String(p.pause_from ?? '') : '';
  if (current && current <= today) start = current;
  let through: string;
  if (Object.hasOwn(b, 'days')) {
    if (!Number.isInteger(b.days) || Number(b.days) < 1 || Number(b.days) > MAX_PAUSE_DAYS) reject(400, 'days');
    through = addDays(start, Number(b.days) - 1);
  } else {
    if (typeof b.through !== 'string' || !validDay(b.through)) reject(400, 'through');
    through = b.through;
  }
  if (through < (start > today ? start : today) || through > addDays(start, MAX_PAUSE_DAYS - 1)) reject(400, 'through');
  if (current && current !== start) await ctx.store.endPause(uid, current, null);
  await ctx.store.putPause(uid, start, through, iso(ctx.now));
  service.log({ event: 'pause', user: uid, days: daysBetween(start, through) + 1 });
  await record(service, uid, [{ kind: 'pause.set', id: again(start), fields: { via: 'web', from: start, through } }]);
  return profileView({ ...p, pause_from: start, pause_through: through }, ctx.now, ctx.inboundDomain);
}
const sessionsOf = (items: Item[]): Key[] =>
  items.filter((i) => String(i.sk).startsWith('SESSION#')).map((i) => ({ pk: String(i.sk), sk: 'SESSION' }));
// The standing address and the calendar feed link: private tokens the profile points at.
const handleKeys = (p: Item): Key[] => [
  ...(p.inbox ? [{ pk: 'INBOX#' + p.inbox, sk: 'INBOX' }] : []),
  ...(p.calendar ? [{ pk: 'CALENDAR#' + p.calendar, sk: 'CALENDAR' }] : [])
];
const handle = (value: unknown) => (value ? String(value) : null);
export async function deleteAccount(service: SessionService, b: Item): Promise<string> {
  const { uid, profile: p, session: s } = await service.account(true),
    ctx = service.context,
    code = validCode(b.code);
  if (!code) reject(400, 'email-and-code');
  await service.checkCode(String(p.email), code, 'delete');
  // Explicit purpose proof grants deletion cleanup; regular writes retain guards.
  ctx.store = service.rawStore;
  await new OAuthService(ctx).deleteUser(uid);
  const items = await ctx.store.userItems(uid),
    files = (rows: Item[]) =>
      rows.flatMap((i) => [
        ...(String(i.raw_key ?? '').startsWith('raw/') ? [String(i.raw_key)] : []),
        ...keys(i),
        // The profile photo (profile-photo.ts), on PROFILE.
        ...(photoOf(i, uid) ? [photoOf(i, uid)!] : []),
        ...(String(i.export_key ?? '').startsWith(`exports/${uid}/`) ? [String(i.export_key)] : [])
      ]);
  for (const key of files(items)) await ctx.objects.remove(key);
  const remove: Key[] = [
    ...items
      .filter((i) => String(i.sk).startsWith('DAY#') && i.token)
      .map((i) => ({ pk: 'TOKEN#' + i.token, sk: 'TOKEN' })),
    ...handleKeys(p),
    ...sessionsOf(items),
    ...items.filter((i) => i.sk !== 'PROFILE').map((i) => ({ pk: String(i.pk), sk: String(i.sk) })),
    ...(await ctx.store.loginKeys(digest(String(p.email)))),
    { pk: 'EMAIL#' + p.email, sk: 'EMAIL' }
  ];
  await ctx.store.deleteKeys(remove);
  let deleted = false;
  for (let i = 0; i < 3; i++) {
    const again = (await ctx.store.profile(uid)) ?? {};
    await ctx.store.deleteKeys(handleKeys(again));
    if (await ctx.store.deleteProfile(uid, handle(again.inbox), handle(again.calendar))) {
      deleted = true;
      break;
    }
  }
  if (!deleted) reject(409, 'busy');
  const late = await ctx.store.userItems(uid);
  for (const key of files(late)) await ctx.objects.remove(key);
  await ctx.store.deleteKeys([
    ...late
      .filter((i) => String(i.sk).startsWith('DAY#') && i.token)
      .map((i) => ({ pk: 'TOKEN#' + i.token, sk: 'TOKEN' })),
    ...sessionsOf(late),
    ...late.map((i) => ({ pk: String(i.pk), sk: String(i.sk) }))
  ]);
  for (const key of [...items, ...late].flatMap((i) => thumbKeys(i))) await ctx.objects.remove(key);
  // A file may have been staged while its last table proof was in flight.
  for (const prefix of [`media/${uid}/`, `exports/${uid}/`])
    for (const key of await ctx.objects.list(prefix)) await ctx.objects.remove(key);
  await ctx.store.deleteSession(String(s.hash));
  await service.tally('deletes');
  service.log({ event: 'account-deleted', user: uid, items: items.length + late.length });
  return clearCookie();
}
