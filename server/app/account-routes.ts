import { SessionService, reject, type ApiContext } from '../../packages/backend/sessions.ts';
import {
  updateAccount,
  changePause,
  deleteAccount,
  replyToken,
  lookUpWeeklyThing,
  recheckWeeklyThing,
  subscribeWeeklyThing
} from '../../packages/backend/accounts.ts';
import { profileView } from '../../packages/backend/views.ts';
import { isAdmin } from '../../packages/backend/product-updates.ts';
import { Tokens } from '../../packages/backend/tokens.ts';
import { pinnedTags, storedPins, tagRow } from '../../packages/backend/tag-row.ts';
import * as auth from '../../packages/backend/auth.ts';
import { OAuthService } from '../../packages/backend/oauth.ts';
import { iso, localDay, validDay, validTimezone, anniversary, parseDay } from '../../packages/domain/dates.ts';
import { computeVersion } from '../../packages/domain/version.ts';
import { pythonTrim, codePointLength } from '../../packages/domain/unicode.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import { signinMessage, deleteMessage } from '../../packages/mail/auth.ts';
import { checkTurnstile, turnstileClient, turnstileToken } from '../../packages/backend/turnstile.ts';
import { ACTIVITY_FAMILIES, activityId, activityView, familyOf, titled } from '../../packages/domain/activity.ts';
import { eventId, recordActivity } from '../../packages/backend/activity.ts';
import { spotOf, type SpotNames } from '../../packages/backend/places.ts';
import { spendHere } from '../../packages/backend/here-budget.ts';
import { photoLink, removePhoto, setPhoto } from '../../packages/backend/profile-photo.ts';
import { findEgg } from '../../packages/backend/eggs.ts';
import { json, body } from './requests.ts';
const ACTIVITY_SHOWN = 100;
/** A page of one family's rows, reading on past the others, up to a limit: a
 * page cut there says where to go on from, with few rows or none. */
async function familyPage(
  store: ApiContext['store'],
  user: string,
  family: string,
  before: string | undefined
): Promise<{ rows: Item[]; next: string | null }> {
  const rows: Item[] = [];
  let from = before,
    read = 0;
  for (;;) {
    const page = await store.activity(user, { before: from, limit: 200 });
    for (const row of page.rows) {
      if (familyOf(String(row.kind)) === family) {
        if (rows.length >= ACTIVITY_SHOWN) return { rows, next: from ?? null };
        rows.push(row);
      }
      from = activityId(String(row.sk));
      if (++read >= 2000) return { rows, next: page.more || row !== page.rows.at(-1) ? from : null };
    }
    if (!page.more) return { rows, next: null };
  }
}
export async function accountRoutes(
  service: SessionService,
  pattern: string,
  args: string[],
  query: URLSearchParams,
  viewer: string
): Promise<Response | null> {
  const ctx = service.context,
    store = ctx.store,
    method = service.request.method;
  if (pattern === '/api/health') return json({ ok: true });
  if (pattern === '/api/sample') {
    const tz = query.get('tz') || 'America/Chicago';
    if (!validTimezone(tz)) reject(400, 'tz');
    const today = localDay(ctx.now, tz),
      birthday = query.get('birthday') ?? '1981-06-14';
    if (!validDay(birthday) || birthday < '1900-01-01' || birthday > today) reject(400, 'birthday');
    const v = computeVersion(birthday, today),
      born = parseDay(birthday),
      age = v.age + 1;
    return json({
      birthday,
      version: v.toString(),
      age: v.age,
      next: {
        version: `${Math.floor(age / 10)}.${age % 10}.0`,
        date: anniversary(born.year + age, born.month, born.day),
        days: v.daysUntil
      }
    });
  }
  if (pattern === '/api/auth/start') {
    const b = await body(service.request),
      email = auth.normalEmail(b.email);
    if (!email) reject(400, 'email');
    // Before any limit is spent or mail sent; observe mode only records it.
    const turnstile = await checkTurnstile({
      token: turnstileToken(b),
      email,
      viewer,
      store,
      now: ctx.now,
      config: ctx.turnstile
    });
    service.log({
      event: 'turnstile',
      result: turnstile.result,
      mode: turnstile.mode,
      allowed: turnstile.allowed,
      reused: turnstile.reused,
      codes: turnstile.codes.join(','),
      ...(turnstile.hostname ? { hostname: turnstile.hostname } : {}),
      ...(turnstile.action ? { action: turnstile.action } : {}),
      ...turnstileClient(b)
    });
    if (!turnstile.allowed) reject(403, 'turnstile');
    await service.reserveMail(email, viewer, (await store.userForEmail(email)) !== null);
    const login = await service.newLogin(email);
    try {
      await ctx.mail.send(
        await signinMessage({
          to: email,
          fromAddr: ctx.from,
          link: ctx.origin + '/signin/#t=' + login.token,
          code: login.code
        }),
        email
      );
    } catch {
      service.log({ event: 'mail-failed' });
      reject(502, 'mail-failed');
    }
    service.log({ event: 'signin-sent' });
    return json({ ok: true }, 202);
  }
  if (pattern === '/api/auth/link') {
    // Someone can send a member their own link, and one tap would sign the
    // member in to the sender's account. The page says whose account a link
    // opens, and which this browser is in now (2026-11-08, SIGNIN-3).
    const token = auth.validToken((await body(service.request)).token),
      email = token ? await store.loginEmail(auth.digest(token), ctx.now) : null;
    if (!email) reject(400, 'link-used-or-expired');
    const s = await service.session(),
      current = s?.user_id ? await store.profile(String(s.user_id)) : null;
    return json({ email, signed_in_as: current?.email ? String(current.email) : null });
  }
  if (pattern === '/api/auth/verify') {
    const b = await body(service.request);
    let login: Item, how: string;
    if (Object.hasOwn(b, 'token')) {
      const token = auth.validToken(b.token),
        found = token ? await store.burnLogin(auth.digest(token), ctx.now) : null;
      if (!found) reject(400, 'link-used-or-expired');
      login = found;
      how = 'link';
    } else {
      const email = auth.normalEmail(b.email),
        code = auth.validCode(b.code);
      if (!email || !code) reject(400, 'email-and-code');
      login = await service.checkCode(email, code);
      how = 'code';
    }
    const email = String(login.email),
      uid = await store.userForEmail(email),
      token = auth.newToken();
    // A session for an address with no account yet is in no account's list,
    // so neither deleting an account nor signing out other devices ends it;
    // it lasts an hour to sign up in, and sign-up gives it a whole session
    // (2026-11-08, SIGNIN-4; an hour since 2026-11-09).
    if (
      !(await store.createSession(auth.digest(token), {
        user_id: uid,
        email: uid ? null : email,
        now: ctx.now,
        expires: uid ? auth.sessionExpiry(ctx.now) : ctx.now + auth.SIGNUP_TTL
      }))
    )
      reject(403, 'no-account');
    if (service.token) await store.deleteSession(auth.digest(service.token));
    service.log({ event: 'signin', how, user: uid ?? 'new' });
    if (uid)
      await recordActivity(store, uid, ctx.now, [{ kind: 'signin', id: eventId(), fields: { how } }], (f) =>
        service.log(f)
      );
    return json({ new: uid === null }, 200, { 'set-cookie': auth.sessionCookie(token) });
  }
  if (pattern === '/api/auth/signout') {
    if (service.token) await store.deleteSession(auth.digest(service.token));
    return json({ ok: true }, 200, { 'set-cookie': auth.clearCookie() });
  }
  if (pattern === '/api/auth/signout-others') {
    // Every other browser signed in to the account is signed out; this one
    // stays. Apps and API tokens keep their access: Connections and API
    // tokens in Settings end those.
    const { uid, session } = await service.account(),
      ended = await ctx.store.endOtherSessions(uid, String(session.hash), ctx.now);
    service.log({ event: 'signout-others', user: uid, ended });
    return json({ ended });
  }
  if (pattern === '/api/unsubscribe') {
    const token = query.get('t') ?? '';
    if (!/^[a-z2-7]{24}$/.test(token)) reject(400, 'token');
    if (method === 'GET') return json({}, 302, { location: '/unsubscribe/#t=' + token });
    const found = await store.getToken(token),
      p = found ? await store.profile(String(found.user_id)) : null;
    if (!found || !p) reject(404, 'token');
    if (p.status !== 'stopped') {
      const user = String(found.user_id);
      await store.stop(user, 'unsubscribed', iso(ctx.now));
      await service.tally('unsubscribes');
      // Counted on the dashboards; the tally alone is monthly and not in the logs.
      service.log({ event: 'unsubscribe', user, reason: 'unsubscribed' });
      await recordActivity(
        store,
        user,
        ctx.now,
        [{ kind: 'status.stopped', id: eventId(), fields: { via: 'web', reason: 'unsubscribed' } }],
        (f) => service.log(f)
      );
    }
    return json({ ok: true });
  }
  if (pattern === '/api/me') {
    if (method === 'PUT') {
      const session = await service.signedIn();
      const view = await updateAccount(service, await body(service.request));
      return json({ ...view, ...(ctx.adminUserId && session.user_id === ctx.adminUserId ? { admin: true } : {}) });
    }
    if (method === 'DELETE')
      return json({ ok: true }, 200, { 'set-cookie': await deleteAccount(service, await body(service.request)) });
    const s = await service.signedIn();
    // A new address hears whether it may make an account before setup asks
    // for anything; the save checks again.
    if (!s.user_id) {
      const { weekly_thing } = await lookUpWeeklyThing(service, String(s.email));
      return json({ new: true, email: s.email, ...(weekly_thing ? { weekly_thing } : {}) });
    }
    const { uid, profile: stored, session } = await service.account(),
      profile = await recheckWeeklyThing(service, uid, stored, Number(session.created_at));
    return json({
      ...profileView(profile, ctx.now, ctx.inboundDomain),
      ...(isAdmin(profile, ctx.adminUserId) ? { admin: true } : {})
    });
  }
  if (pattern === '/api/me/photo') {
    // The profile photo (profile-photo.ts): set or replaced from a checked
    // upload, removed, or shown by a redirect to a fresh signed link.
    if (method === 'PUT') return json(await setPhoto(service, await body(service.request)));
    if (method === 'DELETE') return json(await removePhoto(service));
    return json({}, 302, { location: await photoLink(service) });
  }
  // An easter egg found on the page (backend/eggs.ts): once an egg.
  if (pattern === '/api/eggs') return json(await findEgg(service, await body(service.request)));
  // "Subscribe this address": the session's verified address, never a typed one.
  if (pattern === '/api/me/weekly-thing') return json(await subscribeWeeklyThing(service));
  if (pattern === '/api/me/delete-code') {
    const { uid, profile: p } = await service.account(true);
    await service.reserveMail(String(p.email), undefined, true);
    const { code } = await service.newLogin(String(p.email), 'delete');
    try {
      await ctx.mail.send(await deleteMessage({ to: String(p.email), fromAddr: ctx.from, code }), String(p.email));
    } catch {
      reject(502, 'mail-failed');
    }
    service.log({ event: 'delete-code-sent', user: uid });
    return json({ ok: true }, 202);
  }
  if (pattern === '/api/activity') {
    // The owner's activity log (docs/WEB-APP.md, Activity), newest first, a
    // page at a time: `before` is the last row's id on the page before. A
    // mail row's words appear only when its sender was proven and it was not
    // filed.
    const { uid, profile: p } = await service.account(),
      before = query.get('before') ?? undefined,
      family = query.get('family');
    if (before !== undefined && (before.length > 300 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z(#|$)/.test(before)))
      reject(400, 'before');
    if (family !== null && !(ACTIVITY_FAMILIES as readonly string[]).includes(family)) reject(400, 'family');
    const page = family
        ? await familyPage(store, uid, family, before)
        : await store.activity(uid, { before, limit: ACTIVITY_SHOWN }).then(({ rows, more }) => ({
            rows,
            next: more ? activityId(String(rows.at(-1)!.sk)) : null
          })),
      // An Upcoming date's title, read now: the log never keeps it.
      titles = new Map(
        page.rows.some((r) => r.upcoming)
          ? (await store.upcomingEntries(uid)).map((e) => [e.id, e.title] as [string, string])
          : []
      );
    return json({
      email: p.email,
      tz: p.tz,
      today: localDay(ctx.now, String(p.tz)),
      entries: page.rows.map((r) => titled(activityView(r), titles)),
      next: page.next,
      // Whether the page offers its Check-ins filter.
      ...(before === undefined ? { check_ins: (await store.checkInsBelow(uid, undefined, 1)).items.length > 0 } : {})
    });
  }
  if (pattern === '/api/places') {
    await service.signedIn();
    const q = pythonTrim(query.get('q') ?? '');
    if (codePointLength(q) < 2 || codePointLength(q) > 80) reject(400, 'query');
    try {
      return json({ places: await service.geocode(q) });
    } catch {
      reject(502, 'places-failed');
    }
  }
  if (pattern === '/api/places/here') {
    // The device's spot, named for a note (AGENTS.md, Where a note was):
    // the city, the neighbourhood, and businesses near enough to offer.
    // Coordinates travel in the body, never a logged URL. Each is a paid
    // lookup, so it takes an account and counts against the day's spots,
    // shared with /v1 (here-budget.ts).
    const { uid } = await service.account();
    const spot = spotOf(await body(service.request));
    if (!spot) reject(400, 'place');
    const left = await spendHere(service.context.store, uid, ctx.now);
    if (left === 'limit') reject(429, 'here-limit');
    if (left === 'busy') reject(409, 'try-again');
    let named: SpotNames | null;
    try {
      named = await service.nameSpot(spot);
    } catch {
      reject(502, 'places-failed');
    }
    if (!named?.city) reject(404, 'place-unnamed');
    return json({
      name: named.city,
      region: named.region ?? '',
      country: named.country ?? '',
      ...(named.tz ? { tz: named.tz } : {}),
      ...(named.district ? { district: named.district } : {}),
      nearby: named.nearby,
      ...spot,
      from: 'device'
    });
  }
  // The tag row (backend/tag-row.ts): pinned tags, the same here and through
  // every API token, then the most used of the last 30 days.
  if (pattern === '/api/tag-row') {
    const { uid, profile: p } = await service.account(),
      today = localDay(ctx.now, String(p.tz));
    if (method !== 'PUT') return json(await tagRow(ctx.store, uid, p, today));
    const pins = pinnedTags((await body(service.request))?.pinned);
    if (!pins) reject(400, 'pins');
    const old = Array.isArray(p.pinned_tags) ? storedPins(p) : null;
    if (!(await ctx.store.setPins(uid, pins, old))) reject(409, 'try-again');
    if (JSON.stringify(old ?? []) !== JSON.stringify(pins))
      await recordActivity(
        ctx.store,
        uid,
        ctx.now,
        [
          {
            kind: 'settings.changed',
            id: eventId(),
            fields: { via: 'web', changes: [{ field: 'pinned_tags', from: old ?? [], to: pins }] }
          }
        ],
        (f) => service.log(f)
      );
    return json(await tagRow(ctx.store, uid, { ...p, pinned_tags: pins }, today));
  }
  if (pattern === '/api/me/inbox') {
    const { uid, profile: p } = await service.account(),
      token = replyToken();
    if (!(await ctx.store.setInbox(uid, token, iso(ctx.now), p.inbox ? String(p.inbox) : null)))
      reject(409, 'try-again');
    await recordActivity(
      ctx.store,
      uid,
      ctx.now,
      [{ kind: p.inbox ? 'address.replaced' : 'address.created', id: eventId(), fields: { via: 'web' } }],
      (f) => service.log(f)
    );
    return json({ inbox: token + '@' + ctx.inboundDomain });
  }
  if (pattern.startsWith('/api/mcp/')) {
    const { uid } = await service.account(),
      oauth = new OAuthService(ctx);
    if (pattern.endsWith('/authorize')) return json(await oauth.authorize(uid, await body(service.request)));
    if (pattern.endsWith('/activity')) return json(await oauth.activity(uid));
    if (pattern.endsWith('/scope')) return json(await oauth.grant(uid, args[0]!, (await body(service.request)).scope));
    if (args[0]) return json(await oauth.disconnect(uid, args[0], query.get('write_only') === 'true'));
    return json(await oauth.connections(uid));
  }
  // API tokens (docs/API.md): every subscriber's own, in their session.
  if (pattern.startsWith('/api/tokens')) {
    const { uid } = await service.account(),
      tokens = new Tokens({ store, origin: ctx.origin, now: ctx.now, log: (f) => service.log(f) });
    if (args[0]) return json(await tokens.revoke(uid, args[0]));
    if (method === 'POST') return json(await tokens.make(uid, await body(service.request)), 201);
    return json(await tokens.list(uid));
  }
  if (pattern === '/api/pause')
    return json(await changePause(service, method === 'DELETE' ? null : await body(service.request)));
  return null;
}
