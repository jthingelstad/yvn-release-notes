/** The existing describe stream reader makes thumbnails for everyone, names
 * first-photo places, and describes only opted-in accounts. Operator backfills
 * remain explicit, chain-limited and off by default. No third stream reader. */
import { randomUUID } from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GeoPlacesClient } from '@aws-sdk/client-geo-places';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { createStore, createObjects, createInvocations } from '../packages/backend/aws.ts';
import { safeLog, type Invocations, type Objects } from '../packages/backend/services.ts';
import type { Item } from '../packages/backend/store.ts';
import type { NoteRecord, PlaceRecord } from '../packages/domain/notes.ts';
import { localDay, validTimezone } from '../packages/domain/dates.ts';
import * as describe from '../packages/backend/describe.ts';
import * as thumbs from '../packages/backend/thumbs.ts';
import * as places from '../packages/backend/places.ts';
import * as weather from '../packages/backend/weather.ts';
export interface Services extends describe.Services {
  invocations: Invocations;
  self: string;
  maker?: thumbs.Maker;
  geocode?: (lat: number, lon: number) => Promise<PlaceRecord | null>;
  weatherFetch?: places.JsonFetch;
}
export interface Context {
  getRemainingTimeInMillis?: () => number;
}
const clock = (s: Services) => Math.floor((s.clock ?? (() => Date.now() / 1000))());
const alive = async (s: Services, user: string) => {
  const p = await s.store.profile(user, true);
  return p && !p.mcp_deleting ? p : null;
};
async function thumbnail(note: NoteRecord, user: string, s: Services): Promise<number> {
  if (!s.maker || !(await alive(s, user))) return 0;
  const sources = new Map((note.media ?? []).map((m) => [Number(m.n), String(m.key)]));
  const adapter = {
    async setMediaField(u: string, day: string, id: string, n: number, field: string, value: unknown) {
      const source = sources.get(n);
      if (!source) return false;
      const saved = await s.store.setMediaFieldGuarded(u, day, id, n, field, value, source);
      if (field === 'thumb') {
        const generated = places.object(value)?.key;
        if (!saved && generated) {
          const current = await s.store.note(u, day, id, true),
            entry = (current?.media as Item[] | undefined)?.find((m) => Number(m.n) === n && m.key === source);
          // Another reader may have referenced this exact fixed thumbnail already.
          // Returning success prevents the shared helper deleting its winner's file.
          if (places.object(entry?.thumb)?.key === generated) {
            await s.objects.tag(String(generated), { outcome: 'note' });
            return true;
          }
        }
        if (saved && generated) await s.objects.tag(String(generated), { outcome: 'note' });
      }
      return saved;
    }
  };
  const staged: Objects = new Proxy(s.objects, {
    get(target, property) {
      if (property === 'put')
        return (key: string, body: Buffer, options: Parameters<Objects['put']>[2]) =>
          target.put(key, body, { ...options, tags: { ...options.tags, outcome: 'pending' } });
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return thumbs.thumbnail(note, user, adapter, staged, s.maker);
}
export async function placeNote(note: NoteRecord, user: string, s: Services): Promise<string | null> {
  const spot = places.firstPhoto(note);
  if (note.place || !spot || !s.geocode || !(await alive(s, user))) return null;
  const [, day, id] = String(note.sk).split('#');
  if (!day || !id) return null;
  const first = (note.media ?? []).find(
    (m) =>
      m.kind === 'image' &&
      typeof places.object(m.place)?.lat === 'number' &&
      typeof places.object(m.place)?.lon === 'number'
  );
  if (!first) return null;
  const source = { n: Number(first.n), key: String(first.key), ...spot };
  const named = await s.geocode(spot.lat, spot.lon);
  if (!(await s.store.setNotePlaceGuarded(user, day, id, { ...named, ...spot, from: 'photo' }, source))) return 'gone';
  const profile = await alive(s, user);
  if (profile && typeof profile.tz === 'string' && validTimezone(profile.tz)) {
    const now = clock(s);
    try {
      await weather.keepDay(
        s.store.forLiveAccount(user),
        user,
        weather.placeOf(profile),
        profile.tz,
        day,
        localDay(now, profile.tz),
        s.weatherFetch ?? places.fetchJson,
        new Date(now * 1000).toISOString().replace('.000Z', ''),
        true
      );
    } catch {
      s.log?.({ event: 'weather-error', user, date: day, outcome: 'unavailable' });
    }
  }
  return named ? 'named' : 'unnamed';
}
export type StreamRecord = {
  dynamodb?: { NewImage?: Record<string, AttributeValue>; OldImage?: Record<string, AttributeValue> };
};
export async function changed(record: StreamRecord, s: Services): Promise<number> {
  const row = unmarshall(record.dynamodb?.NewImage ?? {}),
    old = unmarshall(record.dynamodb?.OldImage ?? {});
  if (!String(row.pk ?? '').startsWith('USER#')) return 0;
  const user = String(row.pk).slice(5);
  if (row.sk === 'PROFILE') {
    if (row.describe && !old.describe && (await describe.wanted(s.store, user))) {
      await s.invocations.invoke(s.self, { describe_all: user });
      s.log?.({ event: 'describe-all-start', user });
    }
    return 0;
  }
  if (!String(row.sk ?? '').startsWith('NOTE#')) return 0;
  const [, day, id] = String(row.sk).split('#');
  if (!day || !id) return 0;
  let note = await s.store.note(user, day, id, true);
  if (!note) return 0;
  if (thumbs.waiting(note).length) {
    const made = await thumbnail(note, user, s);
    s.log?.({ event: 'thumbs', user, photos: made });
  }
  note = await s.store.note(user, day, id, true);
  if (!note) return 0;
  const outcome = await placeNote(note, user, s);
  if (outcome) s.log?.({ event: 'place', user, date: day, outcome });
  if (!describe.waiting(note).length || !(await describe.wanted(s.store, user))) return 0;
  const done = await describe.describe(note, user, s);
  if (done) s.log?.({ event: 'describe', user, photos: done });
  return done;
}
export async function describeAll(
  user: string,
  s: Services,
  timeLeft: () => number,
  chain: string = randomUUID()
): Promise<Item> {
  if (!(await s.store.takeProcessingLock(user, chain, clock(s), describe.LOCK_FOR))) return { photos: 0, more: false };
  let handedOn = false,
    photos = 0;
  try {
    if (!(await describe.wanted(s.store, user))) return { photos, more: false, outcome: 'turned-off' };
    for (const note of await s.store.allNotes(user)) {
      if (!describe.waiting(note).length) continue;
      if (!(await describe.wanted(s.store, user))) return { photos, more: false, outcome: 'turned-off' };
      if (timeLeft() < describe.LEFT_FOR_NEXT) {
        if (await s.store.takeProcessingLock(user, chain, clock(s), describe.LOCK_FOR)) {
          await s.invocations.invoke(s.self, { describe_all: user, chain });
          handedOn = true;
        }
        s.log?.({ event: 'describe-all', user, photos, outcome: handedOn ? 'continued' : 'turned-off' });
        return { photos, more: handedOn };
      }
      photos += await describe.describe(note, user, s);
    }
    s.log?.({ event: 'describe-all', user, photos, outcome: 'done' });
    return { photos, more: false };
  } finally {
    if (!handedOn) await s.store.releaseProcessingLock(user, chain);
  }
}
export async function thumbsAll(users: string[], s: Services, timeLeft: () => number, dryRun = false): Promise<Item> {
  const total = { users: 0, notes: 0, photos: 0, bytes: 0, left: {} as Record<string, number>, made: 0 };
  for (let i = 0; i < users.length; i++) {
    const user = users[i]!,
      notes = await s.store.allNotes(user),
      found = thumbs.counts(notes);
    total.users++;
    for (const field of ['notes', 'photos', 'bytes'] as const) total[field] += found[field];
    for (const [type, n] of Object.entries(found.left)) total.left[type] = (total.left[type] ?? 0) + n;
    if (dryRun) continue;
    for (const note of notes) {
      if (!thumbs.waiting(note).length) continue;
      if (timeLeft() < describe.LEFT_FOR_NEXT) {
        await s.invocations.invoke(s.self, { thumbs_all: users.slice(i) });
        s.log?.({ event: 'thumbs-all', users: users.length - i, made: total.made, outcome: 'continued' });
        return { ...total, more: true };
      }
      total.made += await thumbnail(note, user, s);
    }
  }
  s.log?.({
    event: 'thumbs-all',
    dry_run: dryRun,
    users: total.users,
    photos: total.photos,
    made: total.made,
    outcome: 'done'
  });
  return { ...total, more: false };
}
let runtime: Services | undefined;
export function createSecretSource(client = new SecretsManagerClient({})): describe.SecretSource {
  return {
    async get(id) {
      return (await client.send(new GetSecretValueCommand({ SecretId: id }))).SecretString;
    }
  };
}
function production(): Services {
  const table = process.env.TABLE,
    bucket = process.env.BUCKET,
    self = process.env.SELF,
    secret = process.env.SECRET;
  if (!table || !bucket || !self || !secret) throw new Error('Missing description configuration');
  if (!runtime) {
    const secrets = createSecretSource(),
      geo = new GeoPlacesClient({});
    runtime = {
      store: createStore(table),
      objects: createObjects(bucket),
      invocations: createInvocations(),
      self,
      maker: thumbs.make,
      geocode: (lat, lon) => places.reverse(lat, lon, geo),
      weatherFetch: places.fetchJson,
      log: safeLog,
      model: async () => describe.claudeWith(await describe.keyFrom(secrets, secret))
    };
  }
  return runtime;
}
export async function handler(event: Item, context: Context = {}, injected?: Services): Promise<Item | undefined> {
  const base = injected ?? production();
  let model: Promise<describe.Model> | undefined;
  const s = { ...base, model: () => (model ??= base.model()) },
    timeLeft = () => (context.getRemainingTimeInMillis ? context.getRemainingTimeInMillis() / 1000 : 900);
  try {
    if (event.check === true) {
      try {
        const result = await describe.check(await s.model());
        const { words: _words, ...safe } = result;
        void _words;
        s.log?.({
          event: 'describe-check',
          ok: result.ok === true,
          ...(typeof safe.status === 'number' ? { status: safe.status } : {})
        });
        return result;
      } catch (error) {
        if (error instanceof describe.NoKey) return { ok: false, error: 'no-key' };
        throw error;
      }
    }
    if ('thumbs_all' in event) {
      const users =
        event.thumbs_all === '*'
          ? await s.store.userIds()
          : typeof event.thumbs_all === 'string'
            ? [event.thumbs_all]
            : Array.isArray(event.thumbs_all)
              ? event.thumbs_all.filter((v): v is string => typeof v === 'string')
              : [];
      return thumbsAll(users, s, timeLeft, event.dry_run === true);
    }
    if (typeof event.describe_all === 'string')
      return describeAll(event.describe_all, s, timeLeft, typeof event.chain === 'string' ? event.chain : undefined);
    let failed = false,
      noKey = false;
    for (const record of (event.Records ?? []) as StreamRecord[])
      try {
        await changed(record, s);
      } catch (error) {
        if (error instanceof describe.NoKey) noKey = true;
        else failed = true;
      }
    if (failed) throw new Error('Description batch failed');
    if (noKey) s.log?.({ event: 'describe', outcome: 'no-key' });
  } catch (error) {
    if (error instanceof describe.NoKey) {
      s.log?.({ event: 'describe', outcome: 'no-key' });
      return;
    }
    throw new Error('Description worker failed');
  }
}
