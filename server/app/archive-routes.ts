/** Archive projections share version, search and streak domain helpers. */
import { SessionService, reject } from '../../packages/backend/sessions.ts';
import { dayView, mediaLinks } from '../../packages/backend/views.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import { localDay, addDays } from '../../packages/domain/dates.ts';
import { computeVersion, releaseAge, releaseName, releaseSpan } from '../../packages/domain/version.ts';
import { pauseDays, computeStreak } from '../../packages/domain/streak.ts';
import { searchedText } from '../../packages/domain/search.ts';
import { rounded } from '../../packages/backend/places.ts';
import { badges } from '../../packages/backend/badges.ts';
import { collectedOn, releaseBadges } from '../../packages/domain/badges.ts';
import { json, body, dayFrom, dateOf, pageLimit, searchFrom } from './requests.ts';
export async function renderedDays(
  service: SessionService,
  uid: string,
  p: Item,
  dates: string[],
  provided?: Record<string, Item[]>,
  whole?: Record<string, Item[]>
): Promise<Item[]> {
  const store = service.context.store,
    by: Record<string, Item[]> = { ...provided };
  if (!dates.length) return [];
  const order = [...dates].sort(),
    first = order[0]!,
    last = order.at(-1)!;
  if (!provided) for (const n of await store.notesBetween(uid, first, last)) (by[dateOf(n)] ??= []).push(n);
  const [sky, own] = await Promise.all([store.weatherBetween(uid, first, last), store.placesBetween(uid, first, last)]);
  return Promise.all(
    dates.map((d) =>
      dayView(p, d, by[d] ?? [], sky[d], mediaLinks(service.context.objects, uid), own[d], whole?.[d] ?? by[d] ?? [])
    )
  );
}
export async function archiveRoutes(
  service: SessionService,
  pattern: string,
  args: string[],
  query: URLSearchParams
): Promise<Response | null> {
  if (
    ![
      '/api/today',
      '/api/days',
      '/api/days/{date}',
      '/api/releases',
      '/api/releases/{v}',
      '/api/badges',
      '/api/tags',
      '/api/tags/{tag}',
      '/api/search'
    ].includes(pattern)
  )
    return null;
  const { uid, profile: p } = await service.account(),
    ctx = service.context,
    store = ctx.store,
    today = localDay(ctx.now, String(p.tz));
  if (pattern === '/api/today') {
    const v = computeVersion(String(p.birthday), today),
      have = await store.noteDays(uid),
      paused = pauseDays(await store.pauses(uid), today),
      s = computeStreak(have, have.has(today) ? addDays(today, 1) : today, paused),
      view = (await renderedDays(service, uid, p, [today]))[0]!;
    Object.assign(view, {
      tz: p.tz,
      dots: rounded((v.patch / v.cycleDays) * 24),
      next: { version: `${Math.floor((v.age + 1) / 10)}.${(v.age + 1) % 10}.0`, date: addDays(today, v.daysUntil) },
      streak: { current: s.current, longest: s.longest, today: have.has(today) }
    });
    if (paused.has(today)) view.paused_through = p.pause_through;
    return json(view);
  }
  if (pattern === '/api/days') {
    const limit = pageLimit(query),
      before = query.has('before') ? dayFrom(p, query.get('before'), ctx.now) : null,
      paused = pauseDays(await store.pauses(uid), today),
      placed = await store.placesBetween(uid, String(p.birthday), today),
      dates = new Set([
        ...(await store.sentDays(uid)),
        ...(await store.noteDays(uid)),
        ...paused,
        ...Object.keys(placed)
      ]);
    if (!before) dates.add(today);
    const picked = [...dates]
        .filter((d) => d >= String(p.birthday) && d <= today && (!before || d < before))
        .sort()
        .reverse(),
      page = picked.slice(0, limit),
      views = await renderedDays(service, uid, p, page);
    for (const view of views) if (paused.has(String(view.date))) view.paused = true;
    return json({ today, tz: p.tz, days: views, before: picked.length > limit ? page.at(-1) : null });
  }
  if (pattern === '/api/days/{date}') {
    const day = dayFrom(p, args[0], ctx.now),
      view = (await renderedDays(service, uid, p, [day]))[0]!,
      // The special days a day with notes collected (docs/BADGES.md).
      collected = (view.notes as unknown[]).length && p.badges !== false ? collectedOn(String(p.birthday), day) : [];
    return json({ ...view, ...(collected.length ? { collected } : {}), tz: p.tz, today: day === today });
  }
  if (pattern === '/api/releases') {
    const current = computeVersion(String(p.birthday), today).age,
      seen = new Map<number, { days: Set<string>; notes: number }>([[current, { days: new Set(), notes: 0 }]]);
    for (const n of await store.noteTags(uid)) {
      const day = dateOf(n),
        age = computeVersion(String(p.birthday), day).age,
        item = seen.get(age) ?? { days: new Set(), notes: 0 };
      item.days.add(day);
      item.notes++;
      seen.set(age, item);
    }
    return json({
      today,
      releases: [...seen]
        .filter(([age]) => age >= 0 && age <= current)
        .sort(([a], [b]) => b - a)
        .map(([age, n]) => {
          const [first, last] = releaseSpan(String(p.birthday), age);
          return {
            v: releaseName(age),
            from: first,
            through: last,
            days: n.days.size,
            notes: n.notes,
            ...(age === current ? { current: true } : {})
          };
        })
    });
  }
  if (pattern === '/api/releases/{v}') {
    const age = releaseAge(args[0]!),
      current = computeVersion(String(p.birthday), today).age;
    if (age === null || age > current) reject(404, 'release');
    const [first, last] = releaseSpan(String(p.birthday), age),
      shownLast = last < today ? last : today,
      index = (await store.noteTags(uid)).filter((n) => dateOf(n) >= first && dateOf(n) <= shownLast),
      have = [...new Set(index.map(dateOf))].sort(),
      counts = new Map<string, number>();
    for (const n of index) for (const tag of (n.tags as string[]) ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const after = query.has('after') ? dayFrom(p, query.get('after'), ctx.now) : null,
      picked = have.filter((d) => !after || d > after),
      page = picked.slice(0, pageLimit(query)),
      paused = new Set([...pauseDays(await store.pauses(uid), today)].filter((d) => d >= first && d <= shownLast));
    return json({
      v: releaseName(age),
      current: last >= today,
      from: first,
      through: last,
      today,
      tz: p.tz,
      days_with_notes: have.length,
      notes: index.length,
      longest: computeStreak(new Set(have), addDays(shownLast, 1), paused).longest,
      ...(p.badges !== false ? { badges: releaseBadges(String(p.birthday), age, new Set(have)) } : {}),
      tags: [...counts]
        .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
        .map(([tag, notes]) => ({ tag, notes })),
      days: await renderedDays(service, uid, p, page),
      after: picked.length > page.length ? page.at(-1) : null
    });
  }
  if (pattern === '/api/badges')
    return json({
      today,
      tz: p.tz,
      version: computeVersion(String(p.birthday), today).toString(),
      ...(await badges(store, uid, p, today))
    });
  if (pattern === '/api/tags') {
    const counts = new Map<string, { tag: string; notes: number; days: Set<string>; first: string; last: string }>();
    for (const n of await store.noteTags(uid))
      for (const tag of (n.tags as string[]) ?? []) {
        const d = dateOf(n),
          e = counts.get(tag) ?? { tag, notes: 0, days: new Set(), first: d, last: d };
        e.notes++;
        e.days.add(d);
        if (d < e.first) e.first = d;
        if (d > e.last) e.last = d;
        counts.set(tag, e);
      }
    return json({
      tags: [...counts.values()]
        .sort((a, b) => b.notes - a.notes || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
        .map((e) => ({ ...e, days: e.days.size }))
    });
  }
  const by: Record<string, Item[]> = {};
  let terms: string[] = [],
    every: Item[] | null = null;
  if (pattern === '/api/search') {
    terms = searchFrom(await body(service.request));
    every = await store.allNotes(uid);
    for (const n of every) if (terms.every((t) => searchedText(n).includes(t))) (by[dateOf(n)] ??= []).push(n);
  } else
    for (const n of await store.taggedNotes(uid, args[0]!))
      if (((n.tags as string[]) ?? []).includes(args[0]!)) (by[dateOf(n)] ??= []).push(n);
  const dates = Object.keys(by).sort().reverse(),
    shown = pattern === '/api/search' ? dates.slice(0, 100) : dates;
  // A note with no place shows its whole day's city, so read the whole day
  // where one is shown (a tag page reads its notes alone until then).
  if (!every && shown.some((d) => by[d]!.some((n) => !n.place && !n.place_cleared))) every = await store.allNotes(uid);
  const whole: Record<string, Item[]> = {};
  for (const n of every ?? []) if (by[dateOf(n)]) (whole[dateOf(n)] ??= []).push(n);
  const views = await renderedDays(service, uid, p, shown, by, every ? whole : undefined);
  for (const v of views) delete v.weather;
  return json({
    ...(pattern === '/api/search'
      ? { terms, notes: Object.values(by).reduce((n, v) => n + v.length, 0), day_count: dates.length }
      : { tag: args[0] }),
    today,
    tz: p.tz,
    days: views
  });
}
