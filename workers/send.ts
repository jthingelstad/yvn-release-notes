/** Quarter-hour daily sender. Optional history/weather/photo/product-news reads happen
 * before claiming a local day. The DynamoDB claim prevents competing runs;
 * failed sends restore it conditionally. SES acceptance followed by transport
 * failure remains an unavoidable ambiguous send, as in the original worker.
 * dry_run (including alternate now) reads only and never sends or writes. */
import { randomUUID } from 'node:crypto';
import type { Store, Subscriber, Item } from '../packages/backend/store.ts';
import type { Objects, Mail, Log } from '../packages/backend/services.ts';
import * as media from '../packages/backend/media.ts';
import * as weather from '../packages/backend/weather.ts';
import { fetchJson, object, type JsonFetch } from '../packages/backend/places.ts';
import {
  combine,
  dayLinks,
  placeLabel,
  mapUrl,
  writtenAt,
  type NoteRecord,
  type PlaceRecord
} from '../packages/domain/notes.ts';
import { found as tags } from '../packages/domain/tags.ts';
import { addDays } from '../packages/domain/dates.ts';
import type { ProductUpdate } from '../packages/domain/product-updates.ts';
import { computeStreak, pauseDays, type Streak } from '../packages/domain/streak.ts';
import { computeVersion, releaseName, releaseSpan, sameDayBefore, type Version } from '../packages/domain/version.ts';
import {
  buildMessage,
  newToken,
  welcomeLine,
  SHOWN,
  PHOTOS_A_DAY,
  PHOTOS_AN_EMAIL,
  PHOTO_BYTES,
  type Yesterday,
  type PastDay,
  type OnThisDay,
  type Lifetime,
  type Closed,
  type Inline,
  type Thumbnail
} from '../packages/mail/compose.ts';
export const WINDOW = 3 * 3600,
  RESERVE_MS = 20000,
  WEATHER_BUDGET = 30,
  CENSUS_MS = 10000;
export const UNREAD = Symbol('unread');
export interface SenderServices {
  store: Store;
  mail: Pick<Mail, 'send'>;
  objects: Pick<Objects, 'get'>;
  fromAddress: string;
  inboundDomain: string;
  clock?: () => number;
  weatherFetch?: JsonFetch;
  log?: Log;
  report?: (store: Store, now: number) => Promise<void>;
}
export interface LambdaContext {
  getRemainingTimeInMillis(): number;
}
export interface SenderEvent {
  dry_run?: boolean;
  now?: string;
  send_now?: string;
}
export interface LocalTime {
  day: string;
  hour: number;
  minute: number;
  second: number;
  iso: string;
}
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
export function localNow(now: number, tz: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(now * 1000)),
    read = (key: string) => parts.find((p) => p.type === key)!.value,
    day = `${read('year')}-${read('month')}-${read('day')}`,
    hour = Number(read('hour')),
    minute = Number(read('minute')),
    second = Number(read('second')),
    wall = Date.parse(`${day}T${read('hour')}:${read('minute')}:${read('second')}Z`) / 1000,
    offset = wall - Math.floor(now),
    sign = offset < 0 ? '-' : '+';
  return {
    day,
    hour,
    minute,
    second,
    iso: `${day}T${read('hour')}:${read('minute')}:${read('second')}${sign}${String(Math.floor(Math.abs(offset) / 3600)).padStart(2, '0')}:${String(Math.floor((Math.abs(offset) % 3600) / 60)).padStart(2, '0')}`
  };
}
export function isDue(sub: Subscriber, local: LocalTime): boolean {
  if (sub.last_sent_date && sub.last_sent_date >= local.day) return false;
  const [h, m] = sub.send_time.split(':').map(Number),
    start = h! * 3600 + m! * 60,
    now = local.hour * 3600 + local.minute * 60 + local.second;
  return start <= now && now < Math.min(start + WINDOW, 86400);
}
export async function readStreak(s: SenderServices, sub: Subscriber, day: string): Promise<Streak | null> {
  try {
    return computeStreak(await s.store.noteDays(sub.user_id), day, pauseDays(await s.store.pauses(sub.user_id), day));
  } catch (e) {
    s.log?.({ event: 'streak-error', user: sub.user_id, date: day, error: errorName(e) });
    return null;
  }
}
export function placesOf(notes: NoteRecord[], own: PlaceRecord | null = null): [string, string | null][] {
  const out: [string, string | null][] = [],
    seen = new Set<string>();
  const add = (p: PlaceRecord) => {
    const name = placeLabel(p);
    if (!name) return;
    const url = mapUrl(p),
      key = JSON.stringify([name, url]);
    if (!seen.has(key)) {
      seen.add(key);
      out.push([name, url]);
    }
  };
  if (own) add(own);
  for (const note of [...notes].sort((a, b) =>
    writtenAt(a) < writtenAt(b) ? -1 : writtenAt(a) > writtenAt(b) ? 1 : 0
  ))
    if (note.place) add(note.place);
  return out;
}
export function thumbsOf(sub: Subscriber, notes: NoteRecord[]): Thumbnail[] {
  const out: Thumbnail[] = [];
  for (const note of notes)
    for (const m of note.media ?? []) {
      const t = object(m.thumb) ?? {};
      if (m.kind === 'image' && String(t.key ?? '').startsWith(`media/${sub.user_id}/`))
        out.push({
          key: String(t.key),
          size: Number(t.size) || 0,
          width: Number(t.width) || 0,
          height: Number(t.height) || 0,
          alt: (sub.describe ? String(m.description ?? '') : '') || 'Photo'
        });
    }
  return out;
}
export async function readYesterday(
  s: SenderServices,
  sub: Subscriber,
  day: string,
  have: Set<string>
): Promise<[Yesterday | null, Item[] | null, Item | null | typeof UNREAD]> {
  const then = addDays(day, -1);
  if (!have.has(then)) return [null, [], UNREAD];
  try {
    const notes = await s.store.dayNotes(sub.user_id, then);
    if (!notes.length) return [null, [], UNREAD];
    const own = await s.store.dayPlace(sub.user_id, then);
    return [
      {
        day: then,
        text: combine(notes),
        links: dayLinks(notes as NoteRecord[]),
        files: media.counts(notes),
        tags: tags(notes.map((n) => n.text ?? '').join('\n\n')),
        others: notes.reduce((n, note) => n + media.others(note), 0),
        places: placesOf(notes, own),
        thumbs: thumbsOf(sub, notes),
        photos: []
      },
      notes,
      own
    ];
  } catch (e) {
    s.log?.({ event: 'yesterday-error', user: sub.user_id, date: day, error: errorName(e) });
    return [null, null, UNREAD];
  }
}
export async function readClosed(
  s: SenderServices,
  sub: Subscriber,
  day: string,
  index: [string, number][]
): Promise<Closed | null> {
  const v = computeVersion(sub.birthday, day);
  if (v.patch || !v.age) return null;
  const [first, last] = releaseSpan(sub.birthday, v.age - 1),
    within = index.filter(([d]) => first <= d && d <= last);
  if (!within.length) return null;
  try {
    const have = new Set(within.map(([d]) => d)),
      paused = [...pauseDays(await s.store.pauses(sub.user_id), last)].filter((d) => d >= first);
    return {
      age: v.age - 1,
      days: have.size,
      notes: within.length,
      photos: within.reduce((n, [, p]) => n + p, 0),
      longest: computeStreak(have, addDays(last, 1), paused).longest
    };
  } catch (e) {
    s.log?.({ event: 'closed-error', user: sub.user_id, date: day, error: errorName(e) });
    return null;
  }
}
export async function readOnThisDay(
  s: SenderServices,
  sub: Subscriber,
  day: string,
  have: Set<string>
): Promise<OnThisDay | null> {
  try {
    const found = sameDayBefore(sub.birthday, day).filter((d) => have.has(d)),
      shown: PastDay[] = [];
    for (const then of found.slice(0, SHOWN)) {
      const notes = await s.store.dayNotes(sub.user_id, then),
        text = combine(notes),
        files = media.counts(notes);
      if (!text && !Object.values(files).some(Boolean)) continue;
      const kept = (await s.store.weatherBetween(sub.user_id, then, then))[then],
        sky = kept ? weather.dayLine(kept as weather.Reading, weather.fahrenheit(sub.place ?? kept)) : null;
      shown.push({
        day: then,
        text,
        links: dayLinks(notes as NoteRecord[]),
        files,
        sky,
        tags: tags(notes.map((n) => n.text ?? '').join('\n\n')),
        thumbs: thumbsOf(sub, notes),
        photos: []
      });
    }
    return shown.length ? { shown, more: found.slice(SHOWN) } : null;
  } catch (e) {
    s.log?.({ event: 'on-this-day-error', user: sub.user_id, date: day, error: errorName(e) });
    return null;
  }
}
export type History = [
  OnThisDay | null,
  Lifetime | null,
  Yesterday | null,
  Item[] | null,
  Item | null | typeof UNREAD,
  Closed | null
];
export async function readHistory(s: SenderServices, sub: Subscriber, day: string): Promise<History> {
  let index: [string, number][];
  try {
    index = await s.store.noteIndex(sub.user_id);
  } catch (e) {
    s.log?.({ event: 'history-error', user: sub.user_id, date: day, error: errorName(e) });
    return [null, null, null, null, UNREAD, null];
  }
  const days = new Set(index.map(([d]) => d)),
    life = index.length
      ? {
          notes: index.length,
          days: days.size,
          photos: index.reduce((n, [, p]) => n + p, 0),
          since: Number([...days].sort()[0]!.slice(0, 4))
        }
      : null,
    [yesterday, notes, own] = await readYesterday(s, sub, day, days);
  return [await readOnThisDay(s, sub, day, days), life, yesterday, notes, own, await readClosed(s, sub, day, index)];
}
export async function withPhotos(
  s: SenderServices,
  sub: Subscriber,
  day: string,
  yesterday: Yesterday | null,
  past: OnThisDay | null
): Promise<[Yesterday | null, OnThisDay | null, Record<string, Buffer>]> {
  if (![...(yesterday ? [yesterday] : []), ...(past?.shown ?? [])].some((b) => b.thumbs.length))
    return [yesterday, past, {}];
  const images: Record<string, Buffer> = {},
    domain = s.fromAddress.split('@')[1];
  let bytes = 0;
  async function take<T extends PastDay | Yesterday>(block: T): Promise<T> {
    const chosen: Inline[] = [];
    for (const t of block.thumbs) {
      if (chosen.length === PHOTOS_A_DAY || Object.keys(images).length === PHOTOS_AN_EMAIL) break;
      if (bytes + t.size > PHOTO_BYTES) break;
      let data: Buffer;
      try {
        data = (await s.objects.get(t.key, { maxBytes: PHOTO_BYTES - bytes })).body;
      } catch (e) {
        if (errorName(e) !== 'NoSuchKey') throw e;
        s.log?.({ event: 'photo-missing', user: sub.user_id, date: day });
        continue;
      }
      if (bytes + data.length > PHOTO_BYTES) break;
      const cid = `${randomUUID()}.photo@${domain}`;
      images[cid] = data;
      bytes += data.length;
      chosen.push({ cid, alt: t.alt, width: t.width, height: t.height });
    }
    return { ...block, photos: chosen };
  }
  try {
    const y = yesterday ? await take(yesterday) : null,
      shown: PastDay[] = [];
    for (const block of past?.shown ?? []) shown.push(await take(block));
    return [y, past ? { ...past, shown } : null, images];
  } catch (e) {
    s.log?.({ event: 'photos-error', user: sub.user_id, date: day, error: errorName(e) });
    return [
      yesterday ? { ...yesterday, photos: [] } : null,
      past ? { ...past, shown: past.shown.map((p) => ({ ...p, photos: [] })) } : null,
      {}
    ];
  }
}
export async function readWeather(
  s: SenderServices,
  sub: Subscriber,
  day: string,
  fetcher: JsonFetch,
  keep: boolean,
  notes: Item[] | null = [],
  own: Item | null | typeof UNREAD = UNREAD
): Promise<string | null> {
  if (!sub.place) return null;
  try {
    const home = weather.placeOf({ ...sub.place, tz: sub.tz });
    if (!home) return null;
    let [yesterday, today] = await weather.morning(home, day, fetcher);
    if (keep && notes !== null) {
      const then = addDays(day, -1);
      if (own === UNREAD) own = await s.store.dayPlace(sub.user_id, then);
      const where = weather.dayPlace(own, notes, sub.tz);
      let at = home;
      if (where && !weather.samePlace(home, where)) {
        yesterday = await weather.history(where, then, day, fetcher);
        at = where;
      }
      if (yesterday)
        await s.store.putWeather(
          sub.user_id,
          then,
          weather.record(yesterday, at, new Date((s.clock ?? (() => Date.now() / 1000))() * 1000).toISOString())
        );
    }
    return today ? weather.forecastLine(today, String(home.city ?? ''), weather.fahrenheit(home)) : null;
  } catch (e) {
    s.log?.({ event: 'weather-error', user: sub.user_id, date: day, error: errorName(e) });
    return null;
  }
}
export function oneRun(fetcher: JsonFetch, budget = WEATHER_BUDGET, timer = () => performance.now() / 1000): JsonFetch {
  const answers = new Map<string, Promise<Item>>();
  let broken = false,
    spent = 0;
  return async (url) => {
    if (broken || spent >= budget) throw new Error('Weather disabled for run');
    let answer = answers.get(url);
    if (!answer) {
      const start = timer();
      answer = fetcher(url)
        .catch((e) => {
          broken = true;
          throw e;
        })
        .finally(() => {
          spent += timer() - start;
        });
      answers.set(url, answer);
    }
    return answer;
  };
}
export async function standing(s: SenderServices, sub: Subscriber): Promise<string | null> {
  try {
    let fresh = await s.store.getSubscriber(sub.user_id, true);
    if (fresh?.inbox) {
      sub.inbox = fresh.inbox;
      return fresh.inbox;
    }
    const token = newToken();
    if (
      await s.store.setInbox(
        sub.user_id,
        token,
        new Date((s.clock ?? (() => Date.now() / 1000))() * 1000).toISOString()
      )
    ) {
      sub.inbox = token;
      return token;
    }
    fresh = await s.store.getSubscriber(sub.user_id, true);
    return fresh?.inbox ?? null;
  } catch (e) {
    s.log?.({ event: 'inbox-error', user: sub.user_id, error: errorName(e) });
    return null;
  }
}
export async function sendOne(
  s: SenderServices,
  sub: Subscriber,
  day: string,
  v: Version,
  fetcher: JsonFetch
): Promise<Item> {
  const previous = sub.last_sent_date,
    streak = await readStreak(s, sub, day);
  let [past, lifetime, yesterday, notes, own, closed] = await readHistory(s, sub, day);
  const productUpdate = await readProductUpdate(s, day);
  const photos = await withPhotos(s, sub, day, yesterday, past);
  [yesterday, past] = photos;
  const forecast = await readWeather(s, sub, day, fetcher, true, notes, own);
  if (!(await s.store.claimDay(sub.user_id, day))) {
    s.log?.({ event: 'skip', user: sub.user_id, date: day, reason: 'already-claimed' });
    return { user: sub.user_id, date: day, outcome: 'already-claimed' };
  }
  const fresh = await s.store.profile(sub.user_id, true);
  if (!fresh || fresh.mcp_deleting || String(fresh.status ?? 'active') !== 'active') {
    try {
      await s.store.releaseDay(sub.user_id, day, previous);
    } catch (e) {
      if (errorName(e) !== 'ConditionalCheckFailedException') throw e;
    }
    s.log?.({ event: 'skip', user: sub.user_id, date: day, reason: 'stopped' });
    return { user: sub.user_id, date: day, outcome: 'stopped' };
  }
  const token = newToken(),
    inbox = await standing(s, sub);
  const cleanup = async () => {
    try {
      await s.store.releaseDay(sub.user_id, day, previous, token);
    } catch (error) {
      // Deletion or a newer claim may have removed/replaced this reservation.
      if (errorName(error) !== 'ConditionalCheckFailedException') throw error;
    }
    try {
      await s.store.dropDay(sub.user_id, day, token);
    } catch {
      s.log?.({ event: 'drop-day-failed', user: sub.user_id, date: day });
    }
  };
  const refused = () => {
    s.log?.({ event: 'skip', user: sub.user_id, date: day, reason: 'account-changed' });
    return { user: sub.user_id, date: day, outcome: 'account-changed' };
  };
  let message: string;
  try {
    if (
      !(await s.store.putDay(
        sub.user_id,
        day,
        String(v),
        token,
        new Date((s.clock ?? (() => Date.now() / 1000))() * 1000).toISOString()
      ))
    ) {
      await cleanup();
      return refused();
    }
    const raw = await buildMessage({
      to: sub.email,
      fromAddr: s.fromAddress,
      token,
      inboundDomain: s.inboundDomain,
      v,
      birthday: sub.birthday,
      day,
      streak,
      past,
      lifetime,
      yesterday,
      closed,
      productUpdate,
      images: photos[2],
      inbox,
      forecast,
      welcome: previous === null ? welcomeLine(sub.send_time, s.fromAddress) : null
    });
    message = await s.mail.send(raw, sub.email, 'daily');
  } catch (e) {
    await cleanup();
    s.log?.({ event: 'error', user: sub.user_id, date: day, error: errorName(e) });
    throw e;
  }
  if (!(await s.store.setDayMessageId(sub.user_id, day, message, token))) {
    await cleanup();
    return refused();
  }
  s.log?.({ event: 'sent', user: sub.user_id, date: day, version: String(v) });
  return { user: sub.user_id, date: day, version: String(v), outcome: 'sent' };
}
export async function readProductUpdate(s: SenderServices, day: string): Promise<ProductUpdate | null> {
  try {
    return await s.store.scheduledProductUpdate(day);
  } catch (error) {
    s.log?.({ event: 'product-update-error', date: day, error: errorName(error) });
    return null;
  }
}
export async function handler(
  event: SenderEvent | null,
  context: LambdaContext | null,
  s: SenderServices
): Promise<Item> {
  event ??= {};
  const dry = Boolean(event.dry_run);
  if (event.now && !dry) throw new TypeError('"now" is for dry runs only; use "send_now" to send outside the window');
  const now = event.now ? Date.parse(event.now) / 1000 : (s.clock ?? (() => Date.now() / 1000))();
  if (!Number.isFinite(now)) throw new RangeError('Invalid now');
  const fetcher = oneRun(s.weatherFetch ?? ((url) => fetchJson(url, weather.MORNING_TIMEOUT)));
  let subs: Subscriber[];
  if (event.send_now) {
    const sub = await s.store.getSubscriber(event.send_now);
    if (!sub || sub.status !== 'active') throw new TypeError('send_now: no active subscriber with that id');
    subs = [sub];
  } else subs = await s.store.activeSubscribers();
  const results: Item[] = [];
  let failed = 0;
  for (const sub of subs) {
    const local = localNow(now, sub.tz),
      day = local.day,
      v = computeVersion(sub.birthday, day);
    if (event.send_now) {
      if (sub.last_sent_date && sub.last_sent_date >= day) {
        s.log?.({ event: 'skip', user: sub.user_id, date: day, reason: 'already-sent' });
        results.push({ user: sub.user_id, date: day, outcome: 'already-sent' });
        continue;
      }
    } else if (!isDue(sub, local)) continue;
    if (context && context.getRemainingTimeInMillis() < RESERVE_MS) {
      s.log?.({ event: 'out-of-time', user: sub.user_id, date: day });
      break;
    }
    if (sub.pausedOn(day)) {
      if (event.send_now) {
        s.log?.({ event: 'skip', user: sub.user_id, date: day, reason: 'paused' });
        results.push({ user: sub.user_id, date: day, outcome: 'paused' });
      }
      continue;
    }
    if (dry) {
      const streak = await readStreak(s, sub, day);
      let [past, life, yesterday, notes, own, closed] = await readHistory(s, sub, day);
      const photo = await withPhotos(s, sub, day, yesterday, past);
      [yesterday, past] = photo;
      const forecast = await readWeather(s, sub, day, fetcher, false, notes, own);
      const productUpdate = await readProductUpdate(s, day);
      results.push({
        user: sub.user_id,
        date: day,
        version: String(v),
        local: local.iso,
        streak: streak?.current ?? null,
        longest: streak?.longest ?? null,
        on_this_day: past ? [...past.shown.map((p) => p.day), ...past.more] : [],
        on_this_day_weather: Boolean(past?.shown.some((p) => p.sky)),
        yesterday: yesterday?.day ?? null,
        yesterday_files: yesterday
          ? {
              ...Object.fromEntries(Object.entries(yesterday.files ?? {}).filter(([, n]) => n)),
              ...(yesterday.others ? { others: yesterday.others } : {})
            }
          : {},
        notes: life?.notes ?? null,
        closed: closed
          ? {
              release: releaseName(closed.age),
              days: closed.days,
              notes: closed.notes,
              photos: closed.photos,
              longest: closed.longest
            }
          : null,
        photos: Object.keys(photo[2]).length,
        photo_bytes: Object.values(photo[2]).reduce((n, p) => n + p.length, 0),
        forecast: Boolean(forecast),
        inbox: Boolean(sub.inbox),
        product_update: productUpdate?.id ?? null
      });
      continue;
    }
    try {
      results.push(await sendOne(s, sub, day, v, fetcher));
    } catch {
      failed++;
    }
  }
  const iso = new Date(now * 1000).toISOString();
  s.log?.({
    event: 'run',
    now: iso,
    dry_run: dry,
    send_now: Boolean(event.send_now),
    due: results.length + failed,
    failed
  });
  if (!dry && !event.send_now) {
    if (context && context.getRemainingTimeInMillis() < CENSUS_MS) s.log?.({ event: 'census-skipped' });
    else
      try {
        await s.report?.(s.store, now);
      } catch (e) {
        s.log?.({ event: 'census-error', error: errorName(e) });
      }
  }
  if (failed) throw new Error(`${failed} send(s) failed`);
  return { dry_run: dry, now: iso, results };
}
