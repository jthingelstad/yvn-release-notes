import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { read } from '../../packages/backend/exif.ts';
import * as media from '../../packages/backend/media.ts';
import * as weather from '../../packages/backend/weather.ts';
import { clean, nameSpot, rounded } from '../../packages/backend/places.ts';
import { make, thumbnail } from '../../packages/backend/thumbs.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import type { Item } from '../../packages/backend/store.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/metadata.json', import.meta.url), 'utf8')) as {
  exif: Array<{ bytes: string; result: Item }>;
  rounded: Array<{ value: number; digits: number; result: number }>;
};
test('JPEG metadata agrees with 509 synthetic originals and malformed variants', () => {
  for (const sample of fixture.exif) assert.deepEqual(read(Buffer.from(sample.bytes, 'base64')), sample.result);
});
// An iPhone HEIC: ftyp, then meta (iinf naming an Exif item, iloc saying
// where its bytes are), then mdat. The EXIF itself is a fixture JPEG's.
function heic(tiff: Buffer, { version = 0, prefix = true } = {}) {
  const box = (type: string, ...parts: Buffer[]) => {
      const body = Buffer.concat(parts),
        head = Buffer.alloc(8);
      head.writeUInt32BE(8 + body.length);
      head.write(type, 4, 'latin1');
      return Buffer.concat([head, body]);
    },
    u16 = (n: number) => Buffer.from([n >> 8, n & 255]),
    u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n);
      return b;
    },
    item = Buffer.concat([u32(prefix ? 6 : 0), prefix ? Buffer.from('Exif\0\0', 'latin1') : Buffer.alloc(0), tiff]),
    infe = (id: number, type: string) =>
      box('infe', Buffer.from([2, 0, 0, 0]), u16(id), u16(0), Buffer.from(type + '\0', 'latin1')),
    iinf = box('iinf', Buffer.from([0, 0, 0, 0]), u16(2), infe(1, 'hvc1'), infe(7, 'Exif')),
    iloc = (at: number) =>
      version === 0
        ? box(
            'iloc',
            Buffer.from([0, 0, 0, 0]),
            u16(0x4400),
            u16(2),
            u16(1),
            u16(0),
            u16(1),
            u32(0),
            u32(4),
            u16(7),
            u16(0),
            u16(1),
            u32(at),
            u32(item.length)
          )
        : box(
            'iloc',
            Buffer.from([1, 0, 0, 0]),
            u16(0x4400),
            u16(2),
            u16(1),
            u16(0),
            u16(0),
            u16(1),
            u32(0),
            u32(4),
            u16(7),
            u16(0),
            u16(0),
            u16(1),
            u32(at),
            u32(item.length)
          ),
    ftyp = box('ftyp', Buffer.from('heicmif1heic', 'latin1')),
    meta = (at: number) => box('meta', Buffer.from([0, 0, 0, 0]), box('hdlr', Buffer.alloc(24)), iinf, iloc(at)),
    before = ftyp.length + meta(0).length + 8 + 4;
  return Buffer.concat([ftyp, meta(before), box('mdat', Buffer.from('hvc1'), item)]);
}
test("an iPhone's HEIC gives its time and place as a JPEG with the same EXIF does", () => {
  const tiffOf = (jpeg: Buffer) => {
      const at = jpeg.indexOf('Exif\0\0', 0, 'latin1');
      return at < 0 ? null : jpeg.subarray(at + 6, at - 4 + jpeg.readUInt16BE(at - 2) + 2);
    },
    placed = fixture.exif.filter((x) => x.result.lat !== undefined).slice(0, 25);
  assert.ok(placed.length > 0);
  for (const sample of placed) {
    const tiff = tiffOf(Buffer.from(sample.bytes, 'base64'))!;
    assert.deepEqual(read(heic(tiff)), sample.result);
    assert.deepEqual(read(heic(tiff, { version: 1, prefix: false })), sample.result);
  }
  // Cut short or without an Exif item: nothing, never a throw.
  const whole = heic(tiffOf(Buffer.from(placed[0]!.bytes, 'base64'))!);
  for (const cut of [12, 40, 100, whole.length - 10]) assert.deepEqual(read(whole.subarray(0, cut)), {});
  assert.deepEqual(read(Buffer.from(whole.toString('latin1').replace('Exif\0\0\0', 'mime\0\0\0'), 'latin1')), {});
});
test('coordinate and thermometer rounding preserves Python binary ties', () => {
  for (const sample of fixture.rounded) assert.equal(rounded(sample.value, sample.digits), sample.result);
});
test('places reject spoofed values and retain only city precision', () => {
  assert.equal(clean({ name: 'Paris', tz: 'Europe/Paris', lat: true, lon: 2 }), null);
  assert.equal(clean({ name: 'Paris', tz: 'nowhere', lat: 48, lon: 2 }), null);
  assert.deepEqual(
    clean({ name: ' Paris ', region: '', country: 'France', tz: 'Europe/Paris', lat: 48.857, lon: 2.352 }),
    { name: 'Paris', region: '', country: 'France', tz: 'Europe/Paris', lat: 48.86, lon: 2.35 }
  );
});
function png(width: number, height: number) {
  const b = Buffer.alloc(29);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
test("Here's naming offers what is near, never a bus stop or a car park, and falls back to the city", async () => {
  const sent: Array<Record<string, unknown>> = [],
    address = {
      Locality: 'Minneapolis',
      District: 'Downtown West',
      Region: { Name: 'Minnesota' },
      Country: { Code2: 'US' }
    },
    poi = (name: string, kind: string, distance: number) => ({
      PlaceType: 'PointOfInterest',
      Title: name,
      Distance: distance,
      Position: [-93.2709812, 44.9778712],
      Categories: [{ Id: kind, Primary: true }],
      Address: address
    }),
    client = (answers: unknown[][]) => ({
      async send(command: { input: Record<string, unknown> }) {
        sent.push(command.input);
        return { ResultItems: answers.shift() };
      }
    });
  const found = await nameSpot(
    { lat: 44.9778, lon: -93.2717, accuracy_m: 20 },
    client([
      [
        poi('Pest Control Minneapolis', 'consumer_services', 3),
        poi('6th St S & Nicollet Mall', 'bus_stop', 10),
        {
          PlaceType: 'PointAddress',
          Title: '603 Nicollet Mall',
          Distance: 20,
          Address: address,
          TimeZone: { Name: 'America/Chicago' }
        },
        poi('Gaviidae Commons Garage', 'parking_garage-parking_house', 34),
        poi('FIVE GUYS', 'fast_food', 41),
        poi('FIVE GUYS', 'fast_food', 44),
        poi('Caribou Coffee', 'fast_food', 50),
        poi('SK Coffee', 'coffee_shop', 63)
      ]
    ]) as never
  );
  assert.deepEqual(found, {
    city: 'Minneapolis',
    region: 'Minnesota',
    country: 'United States',
    district: 'Downtown West',
    tz: 'America/Chicago',
    nearby: [
      { name: 'FIVE GUYS', lat: 44.977871, lon: -93.270981, distance_m: 41 },
      { name: 'Caribou Coffee', lat: 44.977871, lon: -93.270981, distance_m: 50 }
    ]
  });
  // The spot itself goes, kept to be stored, with the zone asked for.
  assert.deepEqual(sent[0], {
    QueryPosition: [-93.2717, 44.9778],
    IntendedUse: 'Storage',
    MaxResults: 15,
    Language: 'en',
    Filter: { IncludePlaceTypes: ['PointOfInterest', 'PointAddress', 'Street'] },
    AdditionalFeatures: ['TimeZone']
  });
  // A vague fix reaches a little further, never past 200 m.
  const vague = await nameSpot(
    { lat: 1, lon: 2, accuracy_m: 5000 },
    client([[poi('SK Coffee', 'coffee_shop', 63), poi('Far', 'cafe', 201)]]) as never
  );
  assert.deepEqual(
    vague!.nearby.map((v) => v.name),
    ['SK Coffee']
  );
  // Nothing nearby with an address: the city alone, as a photo is named.
  sent.length = 0;
  const lone = await nameSpot(
    { lat: 47.9, lon: -91.8 },
    client([[], [{ Address: { Locality: 'Ely', Region: { Name: 'Minnesota' }, Country: { Code2: 'US' } } }]]) as never
  );
  assert.deepEqual(lone, { city: 'Ely', region: 'Minnesota', country: 'United States', nearby: [] });
  assert.deepEqual((sent[1]!.Filter as Record<string, unknown>).IncludePlaceTypes, ['Locality']);
  assert.equal(await nameSpot({ lat: 0, lon: 0 }, client([[], []]) as never), null);
});
test('an emailed PDF kept before 2026-10-29 is still "in the email"; one kept since, or a web file, is not', () => {
  const pdf = { content_type: 'application/pdf', filename: 'p.pdf', size: 20 },
    zip = { content_type: 'application/zip', filename: 'a.zip', size: 20 };
  // Before: the PDF stayed in the raw mail, and the note has no file of its own.
  assert.equal(media.others({ attachments: [pdf, zip] }), 2);
  // A file added on the web to the same note doesn't stand in for it.
  assert.equal(
    media.others({ attachments: [pdf], media: [{ n: 1, kind: 'file', key: 'media/u/files/x.pdf' }] } as never),
    1
  );
  // Since: kept from the email, keyed by its day and message.
  assert.equal(
    media.others({
      attachments: [pdf, zip, { ...pdf, refused: true }],
      media: [{ n: 1, kind: 'file', key: 'media/u/2026-10-29/m/1.pdf' }]
    } as never),
    2
  );
});
test('media checks bytes, drops logos and limits files without losing raw attachment order', () => {
  const parts = [
    { type: 'image/jpeg', filename: 'forged.jpg', data: Buffer.alloc(30000) },
    { type: 'image/png', filename: 'logo.png', data: png(64, 64) },
    ...Array.from({ length: 22 }, (_, n) => ({ type: 'image/png', filename: `photo${n}.png`, data: png(800, 600) }))
  ];
  const refused: number[] = [];
  assert.equal(media.found(parts, refused).length, 20);
  assert.deepEqual(refused, [0, 22, 23]);
  assert.equal(media.uploadType('audio/webm;codecs=opus', 'memo.webm'), 'audio/webm');
  assert.equal(media.mediaType('application/pdf', 'a.pdf'), 'application/pdf');
  assert.equal(media.mediaType('application/octet-stream', 'Scan.PDF'), 'application/pdf');
  assert.equal(media.mediaType('application/zip', 'a.zip'), null);
  assert.equal(media.uploadType('', 'a.pdf'), 'application/pdf');
  assert.deepEqual(media.imageSize(png(800, 600)), [800, 600]);
  assert.equal(media.imageSize(png(1, 1).subarray(0, 12)), null);
  // A PDF of any size is kept, named as the web names files; a fake one is refused.
  const pdfRefused: number[] = [];
  assert.deepEqual(
    media.found(
      [
        { type: 'application/pdf', filename: 'C:\\scans\\menu.pdf', data: Buffer.from('%PDF-1.7 tiny') },
        { type: 'application/pdf', filename: 'fake.pdf', data: Buffer.from('not a pdf') }
      ],
      pdfRefused
    ),
    [['application/pdf', Buffer.from('%PDF-1.7 tiny'), 'menu.pdf']]
  );
  assert.deepEqual(pdfRefused, [1]);
  assert.deepEqual(media.keys({ media: [{ kind: 'image', key: 'media/u1/files/a.jpg' }, { key: 'raw/no' }] }), [
    'media/u1/files/a.jpg',
    'media/u1/files/a.thumb.jpg'
  ]);
});
const reading = (day = '2026-10-11') => ({
  daily: { time: [day], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [2] }
});
const home = { city: 'Home', country: 'United States', region: '', lat: 44, lon: -93, tz: 'America/Chicago' };
test('weather validates readings, uses history archive and rounds Fahrenheit ties to even', async () => {
  assert.deepEqual(weather.dayReading(reading(), '2026-10-11'), { high_c: 20, low_c: 10, code: 2 });
  assert.equal(
    weather.dayReading(
      { daily: { time: ['2026-10-11'], temperature_2m_max: [true], temperature_2m_min: [10], weather_code: [2] } },
      '2026-10-11'
    ),
    null
  );
  const urls: string[] = [];
  await weather.history(home, '2026-01-01', '2026-10-12', async (url) => {
    urls.push(url);
    return reading('2026-01-01');
  });
  assert.ok(urls[0]!.startsWith(weather.ARCHIVE));
  assert.equal(weather.degrees(2.5, false), '2°');
  assert.equal(
    weather.forecastLine({ high_c: 20, low_c: 10, code: 2 }, 'Home', true),
    'Home today: partly cloudy, high 68°, low 50°.'
  );
});
test('a slow weather fetch cannot file weather for an old place', async () => {
  const store = new FakeStore();
  await store.setDayPlace('u1', '2026-10-11', { city: 'Paris', lat: 48.85, lon: 2.35, tz: 'Europe/Paris' });
  const outcome = await weather.keepDay(
    store,
    'u1',
    home,
    home.tz,
    '2026-10-11',
    '2026-10-12',
    async () => {
      await store.setDayPlace('u1', '2026-10-11', { city: 'London', lat: 51.5, lon: -0.12, tz: 'Europe/London' });
      return reading();
    },
    '2026-10-12T00:00:00Z'
  );
  assert.equal(outcome, 'moved');
  assert.deepEqual(await store.weatherBetween('u1', '2026-10-11', '2026-10-11'), {});
});
test('failed replacement weather drops obsolete reading; a rename preserves temperatures', async () => {
  const store = new FakeStore();
  await store.setDayPlace('u1', '2026-10-11', { city: 'Paris', lat: 48.85, lon: 2.35, tz: 'Europe/Paris' });
  await store.putWeather('u1', '2026-10-11', { ...home, high_c: 20, low_c: 10, code: 2 });
  await assert.rejects(
    weather.keepDay(
      store,
      'u1',
      home,
      home.tz,
      '2026-10-11',
      '2026-10-12',
      async () => {
        throw new Error('Unavailable');
      },
      'now',
      true
    )
  );
  assert.deepEqual(await store.weatherBetween('u1', '2026-10-11', '2026-10-11'), {});
  await store.putWeather('u1', '2026-10-11', {
    city: 'Old name',
    region: '',
    country: '',
    lat: 48.85,
    lon: 2.35,
    high_c: 20,
    low_c: 10,
    code: 2
  });
  assert.equal(
    await weather.keepDay(
      store,
      'u1',
      home,
      home.tz,
      '2026-10-11',
      '2026-10-12',
      async () => {
        throw new Error('Must not fetch');
      },
      'now',
      true
    ),
    'renamed'
  );
  assert.equal((await store.weatherBetween('u1', '2026-10-11', '2026-10-11'))['2026-10-11']?.city, 'Paris');
});
test('version-bound copy retains checked bytes if an upload URL is reused', async () => {
  const objects = new FakeObjects(),
    key = 'media/u1/web/a.jpg';
  const version = await objects.put(key, Buffer.from('checked'), { type: 'image/jpeg' });
  await objects.put(key, Buffer.from('replaced'), { type: 'image/jpeg' });
  await objects.copy(key, version, 'media/u1/files/a.jpg', { type: 'image/jpeg', tags: { outcome: 'note' } });
  assert.equal((await objects.get('media/u1/files/a.jpg')).body.toString(), 'checked');
  await objects.remove(key, version);
  assert.equal((await objects.get(key)).body.toString(), 'replaced');
});
test('real thumbnail is upright, bounded, and contains no EXIF GPS or original metadata', async () => {
  const data = await sharp({
    create: { width: 1200, height: 800, channels: 4, background: { r: 20, g: 50, b: 100, alpha: 0.5 } }
  })
    .png()
    .withExif({ IFD0: { Orientation: '6', Artist: 'Fictional camera' } })
    .toBuffer();
  const original = Buffer.from(data),
    made = await make(data);
  assert.ok(made);
  assert.ok(Math.max(made.width, made.height) <= 640);
  assert.ok(made.body.length <= 80 * 1024);
  assert.deepEqual(data, original);
  const info = await sharp(made.body).metadata();
  assert.equal(info.format, 'jpeg');
  assert.equal(info.exif, undefined);
  assert.equal(info.orientation, undefined);
  assert.equal(await make(Buffer.from('not a photo')), null);
});
test('a concurrently deleted photo removes its generated thumbnail', async () => {
  const store = new FakeStore(),
    objects = new FakeObjects(),
    m = { n: 1, kind: 'image', type: 'image/png', key: 'media/u1/files/a.png', size: 29 };
  await objects.put(m.key, png(800, 600), { type: 'image/png' });
  const done = await thumbnail({ sk: 'NOTE#2026-10-11#w-a', media: [m] }, 'u1', store, objects, async () => ({
    body: Buffer.from('jpeg'),
    width: 10,
    height: 10
  }));
  assert.equal(done, 0);
  await assert.rejects(objects.get('media/u1/files/a.thumb.jpg'));
});
test("a HEIC photo's time and place are kept on its media entry, though no thumbnail is made", async () => {
  const sample = fixture.exif.find((x) => x.result.lat !== undefined && x.result.taken_at)!,
    jpeg = Buffer.from(sample.bytes, 'base64'),
    at = jpeg.indexOf('Exif\0\0', 0, 'latin1'),
    store = new FakeStore(),
    objects = new FakeObjects(),
    m = { n: 0, kind: 'image', type: 'image/heic', key: 'media/u1/2026-10-11/w-a/0.heic', size: 99 };
  await store.putNote('u1', '2026-10-11', 'w-a', { text: '', media: [m] });
  await objects.put(m.key, heic(jpeg.subarray(at + 6, at - 2 + jpeg.readUInt16BE(at - 2))), { type: 'image/heic' });
  await thumbnail({ sk: 'NOTE#2026-10-11#w-a', media: [m] }, 'u1', store, objects, async () => null);
  const [kept] = (await store.allNotes('u1'))[0]!.media as Item[];
  assert.deepEqual(kept!.place, { lat: sample.result.lat, lon: sample.result.lon });
  assert.equal(kept!.taken_at, sample.result.taken_at);
});
