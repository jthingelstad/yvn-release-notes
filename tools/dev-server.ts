/** Local HTTP harness. Fictional accounts, in-memory SDK/object/mail
 * fakes and optional fixture processing only; it never creates AWS clients.
 * Repeated --dayone ZIP previews use the real bounded planner/importer with
 * Ada's fake account. Importing this module starts no server or timers. */
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { simpleParser } from 'mailparser';
import { createApp } from '../server/app/app.ts';
import { createMcpApp } from '../server/mcp/app.ts';
import { captureNote } from '../workers/capture.ts';
import { listen } from '../server/shared/listen.ts';
import { FakeStore } from '../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../packages/testing/services.ts';
import type { ApiContext } from '../packages/backend/sessions.ts';
import type { Item } from '../packages/backend/store-types.ts';
import { localDay, addDays, iso } from '../packages/domain/dates.ts';
import { found } from '../packages/domain/tags.ts';
import { runEvent as runExport } from '../workers/export.ts';
import { fakeWriter } from '../packages/testing/commentary.ts';
import * as dayone from '../packages/backend/dayone.ts';
import * as importer from '../packages/backend/importer.ts';
export function devOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      port: { type: 'string', default: '8790' },
      dayone: { type: 'string', multiple: true, default: [] },
      'fake-places': { type: 'boolean' },
      'fake-links': { type: 'boolean' },
      help: { type: 'boolean' }
    }
  });
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local HTTP port');
  return { port, dayone: values.dayone, help: values.help };
}
export async function loadDayOne(
  paths: string[],
  context: {
    store: FakeStore;
    objects: FakeObjects;
    origin: string;
    now: number;
    fetchTitle?: ApiContext['fetchTitle'];
    weatherFetch?: ApiContext['weatherFetch'];
  }
): Promise<Record<string, number>> {
  // A preview is always fictional, regardless of the host's AWS environment.
  if (!(context.store instanceof FakeStore) || !(context.objects instanceof FakeObjects))
    throw new Error('Day One preview requires in-memory services');
  const profile = await context.store.profile('u1', true);
  if (!profile || profile.email !== 'ada@example.com') throw new Error('Day One preview requires fictional Ada');
  const archives: dayone.Archive[] = [];
  try {
    for (const path of paths) archives.push(await dayone.read(path));
    const plans = archives.map((archive) =>
      dayone.plan(archive.journal, archive.entries, archive.names, profile, 'u1', context.origin)
    );
    return await importer.write(
      plans.map((plan, i) => [plan, archives[i]!.read]),
      'u1',
      {
        store: context.store,
        objects: context.objects,
        today: localDay(context.now, String(profile.tz)),
        at: iso(context.now),
        fetchTitle: context.fetchTitle ?? (() => null),
        fetchWeather: context.weatherFetch
      }
    );
  } finally {
    archives.forEach((archive) => archive.close());
  }
}
export async function main(args = process.argv.slice(2)) {
  const options = devOptions(args);
  /** Addresses that asked to be added to the made-up Weekly Thing list. */
  const added = new Set<string>();
  if (options.help) {
    console.log(
      'tools/dev-server.ts [--port 8790] [--dayone ZIP ...] [--fake-places] [--fake-links] — fictional in-memory services only'
    );
    return;
  }
  const port = options.port,
    origin = `http://localhost:${port}`,
    stamp = () => Math.floor(Date.now() / 1000),
    today = localDay(stamp(), 'America/Chicago');
  const profile = {
    pk: 'USER#u1',
    sk: 'PROFILE',
    email: 'ada@example.com',
    birthday: '1981-06-14',
    tz: 'America/Chicago',
    send_time: '06:00',
    status: 'active',
    created_at: '2026-10-01T12:00:00Z',
    last_sent_date: today,
    city: 'Minneapolis',
    region: 'Minnesota',
    country: 'United States',
    lat: 44.98,
    lon: -93.26
  };
  const store = new FakeStore([profile, { pk: 'EMAIL#ada@example.com', sk: 'EMAIL', user_id: 'u1' }]),
    mail = new FakeMail(),
    objects = new FakeObjects(),
    invocations = new FakeInvocations(),
    forms = new Map<string, { key: string; type: string; size: number; expires: number }>(),
    app = new Hono();
  for (let back = 1; back < 8; back++) {
    const day = addDays(today, -back);
    store.seed({ pk: 'USER#u1', sk: 'DAY#' + day, token: 'abcdefghijklmnopqrstuvwx', version: 'fixture' });
    store.seed({
      pk: 'USER#u1',
      sk: 'WEATHER#' + day,
      high_c: 14 + back,
      low_c: 4 + back / 2,
      code: 2,
      city: 'Minneapolis',
      country: 'United States'
    });
  }
  store.seed({ pk: 'TOKEN#abcdefghijklmnopqrstuvwx', sk: 'TOKEN', user_id: 'u1', date: today });
  store.seed({ pk: 'USER#u1', sk: 'PAUSE#' + addDays(today, -12), through: addDays(today, -9) });
  for (const [back, id, late, text] of [
    [0, 'dev-1', 0, 'Walked before the rain came in. Coffee on the porch. #walks'],
    [1, 'dev-2', 0, 'Long day of meetings.\nDinner with the neighbours, who brought the good bread.'],
    [3, 'dev-3', 2, 'Back from the lake. Unpacked, mostly. #cabin #walks'],
    [200, 'w-dev4', 150, 'Filled in later: the day the new bike came.']
  ] as const) {
    const day = addDays(today, -back);
    store.seed({
      pk: 'USER#u1',
      sk: `NOTE#${day}#${id}`,
      text,
      source: id.startsWith('w-') ? 'web' : 'email',
      written_at: addDays(day, late) + 'T17:00:00Z',
      tz: 'America/Chicago',
      tags: found(text),
      // Replies, so they keep their email's subject, as inbound does.
      ...(id.startsWith('w-') ? {} : { raw_key: 'raw/' + id, subject: 'Re: Release notes' })
    });
  }
  store.seed({
    pk: 'USER#u1',
    sk: 'NOTE#2016-07-04#d1-DEV',
    text: 'Fireworks over the harbour.\n\n#vacation #maine-2016',
    source: 'import',
    written_at: '2016-07-05T01:40:00Z',
    tz: 'America/New_York',
    tags: ['vacation', 'maine-2016'],
    place: {
      venue: 'Bar Harbor Town Pier',
      city: 'Bar Harbor',
      region: 'Maine',
      country: 'United States',
      lat: 44.39,
      lon: -68.2
    },
    origin: { app: 'dayone', journal: 'Journal', id: 'DEV' }
  });
  const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=',
      'base64'
    ),
    wave = Buffer.alloc(44 + 16000);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(16000, 40);
  const photo = 'media/u1/fixture/photo.png',
    audio = 'media/u1/fixture/audio.wav';
  await objects.put(photo, image, { type: 'image/png', tags: { outcome: 'note' } });
  await objects.put(audio, wave, { type: 'audio/wav', tags: { outcome: 'note' } });
  const lake = await store.note('u1', addDays(today, -3), 'dev-3');
  store.seed({
    ...lake!,
    media: [
      { n: 1, kind: 'image', type: 'image/png', key: photo, size: image.length },
      { n: 2, kind: 'audio', type: 'audio/wav', key: audio, size: wave.length }
    ]
  });
  objects.download = async (key) => '/dev-media/' + key;
  objects.upload = async (key, type, size, seconds) => {
    const policy = randomUUID();
    forms.set(policy, { key, type, size, expires: stamp() + seconds });
    return {
      url: '/dev-upload/',
      fields: { key, 'Content-Type': type, size: String(size), seconds: String(seconds), policy, tagging: 'pending' }
    };
  };
  const cities = [
    {
      name: 'Minneapolis',
      region: 'Minnesota',
      country: 'United States',
      tz: 'America/Chicago',
      lat: 44.98,
      lon: -93.26
    },
    { name: 'Minneapolis', region: 'Kansas', country: 'United States', tz: 'America/Chicago', lat: 39.12, lon: -97.71 },
    { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 }
  ];
  const context = (): ApiContext => ({
    store,
    objects,
    mail,
    invocations,
    origin,
    now: stamp(),
    from: 'notes@example.com',
    inboundDomain: 'in.yourversionnumber.com',
    senderFunction: 'dev-sender',
    exportFunction: 'dev-export',
    adminUserId: 'u1',
    geocode: async (q) => cities.filter((c) => c.name.toLowerCase().startsWith(q.toLowerCase())),
    // "Here" names any spot as the nearest of these cities, in a made-up
    // neighbourhood beside two made-up businesses, never Amazon Location.
    nameSpot: async ({ lat, lon }) => {
      const near = cities.toSorted(
        (a, b) => Math.hypot(a.lat - lat, a.lon - lon) - Math.hypot(b.lat - lat, b.lon - lon)
      )[0]!;
      return {
        city: near.name,
        region: near.region,
        country: near.country,
        tz: near.tz,
        district: 'Old Town',
        nearby: [
          { name: 'Corner Café', lat: lat + 0.0002, lon, distance_m: 22 },
          { name: 'Reading Room', lat, lon: lon + 0.0004, distance_m: 41 }
        ]
      };
    },
    // The Map page draws on a plain sheet, with no tiles, glyphs or sprites:
    // never Amazon Location.
    maps: {
      style: async (scheme) => ({
        body: new TextEncoder().encode(
          JSON.stringify({
            version: 8,
            sources: {},
            glyphs: 'https://maps.geo.us-east-1.amazonaws.com/v2/glyphs/{fontstack}/{range}.pbf',
            layers: [
              {
                id: 'sheet',
                type: 'background',
                paint: { 'background-color': scheme === 'Dark' ? '#23264f' : '#ece6d6' }
              }
            ]
          })
        ),
        type: 'application/json'
      }),
      tile: async () => null,
      glyphs: async () => null,
      sprites: async () => null
    },
    fetchTitle: (url) => ({ title: 'A page at ' + new URL(url).hostname, site: new URL(url).hostname }),
    weatherFetch: async (url) => {
      const q = new URL(url).searchParams,
        day = localDay(stamp(), q.get('timezone') ?? 'America/Chicago'),
        days = q.has('start_date') ? [q.get('start_date')!] : [addDays(day, -1), day];
      return {
        daily: {
          time: days,
          weather_code: days.map(() => 2),
          temperature_2m_max: days.map(() => 17.5),
          temperature_2m_min: days.map(() => 8)
        }
      };
    },
    // A made-up Weekly Thing list, never the Librarian: an address starting
    // "not-subscribed" isn't on it, "unconfirmed" hasn't confirmed and
    // "member" is a Supporting Member; anyone else gets the issues. Asking
    // to be added leaves it unconfirmed, except "flagged" (held for review).
    weeklyThing: {
      standing: async (email) =>
        added.has(email) || email.startsWith('unconfirmed')
          ? 'unconfirmed'
          : email.startsWith('not-subscribed') || email.startsWith('flagged')
            ? 'none'
            : email.startsWith('member')
              ? 'member'
              : 'reader',
      subscribe: async (email) => {
        if (email.startsWith('flagged')) return { outcome: 'review' };
        added.add(email);
        return { outcome: 'added' };
      }
    },
    log: (f) => console.log(JSON.stringify(f))
  });
  if (options.dayone.length) {
    const counts = await loadDayOne(options.dayone, { ...context(), store, objects });
    console.log('-- a fictional Day One preview: ' + JSON.stringify(counts));
  }
  invocations.invoke = async (name, payload) => {
    invocations.calls.push({ name, payload, asynchronous: true });
    if (name === 'dev-export') {
      const value = payload as Item;
      setTimeout(
        () =>
          // A zip, or a book (`kind: 'book'`), its commentary by a fictional Claude.
          void runExport(value, { store, objects, now: stamp(), writer: async () => fakeWriter }).catch(() =>
            console.log('{"event":"dev-export-failed"}')
          ),
        20
      );
    }
    return null;
  };
  app.get('/dev-runtime/', (c) => c.json({ runtime: 'node24-hono', fictional: true }));
  app.get('/dev-mail/', async (c) => {
    const to = (c.req.query('to') ?? '').toLowerCase(),
      message = mail.messages.filter((m) => m.to === to).at(-1);
    if (!message) return c.text('No mail', 404);
    return c.text((await simpleParser(message.raw)).text ?? '');
  });
  app.get('/dev-media/*', async (c) => {
    try {
      const object = await objects.get(decodeURIComponent(new URL(c.req.url).pathname.slice('/dev-media/'.length)));
      return new Response(new Uint8Array(object.body), {
        headers: { 'content-type': object.type, 'cache-control': 'no-store' }
      });
    } catch {
      return c.text('Not found', 404);
    }
  });
  app.post('/dev-upload/', async (c) => {
    const form = await c.req.raw.formData(),
      policy = String(form.get('policy') ?? ''),
      signed = forms.get(policy),
      file = form.get('file');
    if (
      !signed ||
      signed.expires <= stamp() ||
      !(file instanceof File) ||
      file.size !== signed.size ||
      form.get('key') !== signed.key ||
      form.get('Content-Type') !== signed.type ||
      form.get('tagging') !== 'pending'
    )
      return c.text('Forbidden', 403);
    await objects.put(signed.key, Buffer.from(await file.arrayBuffer()), {
      type: signed.type,
      tags: { outcome: 'pending' }
    });
    return new Response(null, { status: 204 });
  });
  const api = createApp({ context, viewer: () => '127.0.0.1' }),
    mcp = createMcpApp({
      context: () => ({
        ...context(),
        media: {
          download: async (_uid, key) => objects.download(key, '', 600),
          bytes: async (_uid, key, max) => (await objects.get(key, { range: `bytes=0-${max}`, maxBytes: max + 1 })).body
        }
      }),
      capture: (e) => captureNote(e, context(), { fetchTitle: () => null })
    });
  app.all('/mcp', (c) => mcp.fetch(c.req.raw));
  app.all('/api/*', (c) => api.fetch(c.req.raw));
  app.all('/oauth/*', (c) => api.fetch(c.req.raw));
  app.all('/.well-known/*', (c) => api.fetch(c.req.raw));
  // The fictional local harness models opt-in waiting without calling a model.
  const processingSeen = new Map<string, number>();
  setInterval(() => {
    const rows = store.memory.all();
    for (const p of rows.filter((row) => row.sk === 'PROFILE'))
      for (const note of rows.filter((row) => row.pk === p.pk && String(row.sk).startsWith('NOTE#'))) {
        let changed = false;
        for (const entry of (note.media as Item[] | undefined) ?? [])
          for (const [field, setting, kind, types, words] of [
            [
              'transcript',
              'transcribe',
              'audio',
              ['audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/flac'],
              'Made up on this machine: back from the lake, and the loons were out on the water.'
            ],
            [
              'description',
              'describe',
              'image',
              ['image/jpeg', 'image/png', 'image/webp'],
              'Made up on this machine: a red canoe pulled up on a rocky shore, pines behind it.'
            ]
          ] as const) {
            if (
              !p[setting] ||
              entry.kind !== kind ||
              !types.includes(entry.type as never) ||
              Object.hasOwn(entry, field)
            )
              continue;
            const key = JSON.stringify([note.pk, note.sk, entry.n, field]),
              at = processingSeen.get(key) ?? Date.now();
            processingSeen.set(key, at);
            if (Date.now() - at >= 5000) {
              entry[field] = words;
              changed = true;
            }
          }
        if (changed) store.seed(note);
      }
  }, 500).unref();
  const root = resolve('dist/web'),
    types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.webmanifest': 'application/manifest+json',
      '.txt': 'text/plain; charset=utf-8',
      '.xml': 'application/xml; charset=utf-8',
      '.woff2': 'font/woff2'
    };
  app.get('*', async (c) => {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname),
      path = resolve(root, '.' + pathname);
    if (!path.startsWith(root + '/') && path !== root) return c.text('Not found', 404);
    try {
      // As CloudFront does: / is front.html, the front page drawn in for
      // readers that run no script; a public page (site/) is its own
      // index.html, and its address without the final slash is sent to it;
      // any other address but a file, index.html.
      const page = !extname(path) && pathname !== '/' ? resolve(path, 'index.html') : null;
      if (page && existsSync(page) && !pathname.endsWith('/')) return c.redirect(pathname + '/', 301);
      const file = extname(path)
          ? path
          : page && existsSync(page)
            ? page
            : resolve(root, pathname === '/' ? 'front.html' : 'index.html'),
        bytes = await readFile(file);
      return new Response(bytes, {
        headers: {
          'content-type': types[extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; connect-src 'self' https://tinylytics.app; form-action 'self'; frame-ancestors 'none'"
        }
      });
    } catch {
      return c.text('Build the web app first', 404);
    }
  });
  console.log(`Release Notes locally: ${origin}/ (fictional in-memory data)`);
  return listen(app, `127.0.0.1:${port}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch {
    console.error('Local dev server failed');
    process.exitCode = 1;
  }
}
