import { SessionService, reject } from '../../packages/backend/sessions.ts';
import { updateAccount, changePause, deleteAccount, replyToken } from '../../packages/backend/accounts.ts';
import { profileView } from '../../packages/backend/views.ts';
import { isAdmin } from '../../packages/backend/product-updates.ts';
import * as auth from '../../packages/backend/auth.ts';
import { OAuthService } from '../../packages/backend/oauth.ts';
import { iso, localDay, validDay, validTimezone, anniversary, parseDay } from '../../packages/domain/dates.ts';
import { computeVersion } from '../../packages/domain/version.ts';
import { pythonTrim, codePointLength } from '../../packages/domain/unicode.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import { signinMessage, deleteMessage } from '../../packages/mail/auth.ts';
import { checkTurnstile, turnstileClient, turnstileToken } from '../../packages/backend/turnstile.ts';
import { activityId, activityView, titled } from '../../packages/domain/activity.ts';
import { eventId, recordActivity } from '../../packages/backend/activity.ts';
import { spotOf } from '../../packages/backend/places.ts';
import { json, body } from './requests.ts';
const ACTIVITY_SHOWN = 100;
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
    await service.reserveMail(email, viewer);
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
    if (
      !(await store.createSession(auth.digest(token), {
        user_id: uid,
        email: uid ? null : email,
        now: ctx.now,
        expires: auth.sessionExpiry(ctx.now)
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
    if (!s.user_id) return json({ new: true, email: s.email });
    const { profile } = await service.account();
    return json({
      ...profileView(profile, ctx.now, ctx.inboundDomain),
      ...(isAdmin(profile, ctx.adminUserId) ? { admin: true } : {})
    });
  }
  if (pattern === '/api/me/delete-code') {
    const { uid, profile: p } = await service.account(true);
    await service.reserveMail(String(p.email));
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
      before = query.get('before') ?? undefined;
    if (before !== undefined && (before.length > 300 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z(#|$)/.test(before)))
      reject(400, 'before');
    const page = await store.activity(uid, { before, limit: ACTIVITY_SHOWN }),
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
      next: page.more ? activityId(String(page.rows.at(-1)!.sk)) : null
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
    // The device's spot, named at the city for a note (AGENTS.md, Where a
    // note was). Coordinates travel in the body, never a logged URL.
    await service.signedIn();
    const spot = spotOf(await body(service.request));
    if (!spot) reject(400, 'place');
    let named: Item | null;
    try {
      named = await service.reverse(spot.lat, spot.lon);
    } catch {
      reject(502, 'places-failed');
    }
    if (!named?.city) reject(404, 'place-unnamed');
    return json({
      name: named.city,
      region: named.region ?? '',
      country: named.country ?? '',
      ...(named.tz ? { tz: named.tz } : {}),
      ...spot,
      from: 'device'
    });
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
  if (pattern === '/api/pause')
    return json(await changePause(service, method === 'DELETE' ? null : await body(service.request)));
  return null;
}
