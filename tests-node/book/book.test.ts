/** The book: its words, its plan, its photos, a real Typst render and the
 * export worker's book path. Fictional subscribers and photos only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  blocks,
  bookPlan,
  defaultTitle,
  PAGES,
  paragraphs,
  plainText,
  richBlocks,
  span
} from '../../packages/book/data.ts';
import { photo, renderBook, rows, selfTest } from '../../packages/book/render.ts';
import { bookKey, runBook } from '../../workers/export.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import type { Item } from '../../packages/backend/store-types.ts';

const now = Date.parse('2026-10-13T12:00:00Z') / 1000;
type Image = ReturnType<typeof sharp>;
const jpeg = (width: number, height: number, extra: (s: Image) => Image = (s) => s) =>
  extra(sharp({ create: { width, height, channels: 3, background: '#ff5a1f' } }))
    .jpeg()
    .toBuffer();

test('a note’s words keep their paragraphs and lines, with links by name and tags marked', () => {
  assert.deepEqual(
    paragraphs([
      '  Lake day.\r\nCold water.\n\n\nThen ',
      { tag: 'lake', text: '#lake' },
      ' and ',
      { url: 'https://example.com/loons', label: 'Loons', site: 'example.com' },
      '\n',
      { url: 'mailto:ada@example.com', label: 'Write to Ada' },
      '  '
    ]),
    [
      [[{ text: 'Lake day.' }], [{ text: 'Cold water.' }]],
      [
        [
          { text: 'Then ' },
          { text: '#lake', tag: true },
          { text: ' and ' },
          { text: 'Loons', href: 'https://example.com/loons' },
          { text: ' · example.com', muted: true }
        ],
        [{ text: 'Write to Ada' }]
      ]
    ]
  );
  assert.deepEqual(paragraphs(['\n\n  \n']), []);
  // A link named for its own site doesn't print the site again.
  assert.deepEqual(paragraphs([{ url: 'https://www.example.com/', label: 'example.com/', site: 'example.com' }]), [
    [[{ text: 'example.com/', href: 'https://www.example.com/' }]]
  ]);
});

test('lines written as a list print as one, under a short line that heads them', () => {
  const written =
      'Notable things…\n- a walk\n* coffee\n\nFaster for people\n- compressed. #fast\nAfter the list.\n\nAn ending.',
    made = blocks(paragraphs([written.split('#fast')[0]!, { tag: 'fast', text: '#fast' }, written.split('#fast')[1]!]));
  assert.deepEqual(
    made.map((b) => [b.kind, b.lines.map((l) => l.map((s) => s.text).join('')), b.tight ?? false]),
    [
      ['text', ['Notable things…'], false],
      ['list', ['a walk', 'coffee'], true],
      ['head', ['Faster for people'], false],
      ['list', ['compressed. #fast'], true],
      ['text', ['After the list.'], true],
      ['text', ['An ending.'], false]
    ]
  );
  // The tag keeps its mark, and the commentary reads the words as written.
  assert.deepEqual(made[3]!.lines[0]!.at(-1), { text: '#fast', tag: true });
  assert.equal(plainText({ blocks: made }), written.replace('* coffee', '- coffee'));
});

test('a book is named for its release when it starts the release, else for its days', () => {
  // Born 1981-06-14: release 4.5 runs from 2026-06-14 to 2027-06-13.
  assert.equal(defaultTitle('1981-06-14', '2026-06-14', '2026-10-13'), '4.5');
  assert.equal(defaultTitle('1981-06-14', '2026-06-14', '2027-06-13'), '4.5');
  assert.equal(defaultTitle('1981-06-14', '2026-06-14', '2027-06-14'), 'June 14, 2026 to June 14, 2027');
  assert.equal(defaultTitle('1981-06-14', '2026-06-15', '2026-10-13'), 'June 15, 2026 to October 13, 2026');
  assert.equal(span('2026-10-13', '2026-10-13'), 'October 13, 2026');
});

async function subscriber(extra: Item = {}) {
  const store = new FakeStore(),
    objects = new FakeObjects();
  await store.createSubscriber('u1', 'ada@example.com', {
    birthday: '1981-06-14',
    tz: 'America/Chicago',
    status: 'active',
    city: 'Minneapolis',
    region: 'Minnesota',
    country: 'United States',
    lat: 44.98,
    lon: -93.26,
    weekly_thing: 'member',
    ...extra
  });
  await store.putNote('u1', '2026-10-12', 'w-a', {
    text: 'Lake day.\n\nA loon, close. #lake',
    source: 'web',
    written_at: '2026-10-12T20:00:00Z',
    media: [
      { n: 1, kind: 'image', type: 'image/jpeg', key: 'media/u1/files/a.jpg', size: 5, description: 'A loon' },
      { n: 2, kind: 'image', type: 'image/jpeg', key: 'media/u2/files/b.jpg', size: 5 },
      { n: 3, kind: 'image', type: 'image/jpeg', key: 'media/u1/files/gone.jpg', size: 5 },
      { n: 4, kind: 'audio', type: 'audio/mp4', key: 'media/u1/files/c.m4a', size: 5, transcript: 'Hello lake' },
      { n: 5, kind: 'pdf', type: 'application/pdf', key: 'media/u1/files/d.pdf', size: 5, name: 'Map.pdf' }
    ]
  });
  await store.putNote('u1', '2026-10-13', 'w-b', {
    text: 'Packed the car.',
    source: 'mcp',
    author: 'assistant',
    client: 'Claude',
    written_at: '2026-10-13T15:00:00Z',
    place: { city: 'Duluth', region: 'Minnesota', country: 'United States', lat: 46.79, lon: -92.1 }
  });
  await objects.put('media/u1/files/a.jpg', await jpeg(1200, 800), { type: 'image/jpeg' });
  await objects.put('media/u2/files/b.jpg', await jpeg(1200, 800), { type: 'image/jpeg' });
  return { store, objects };
}

test('the plan reads the days as the web does, keeping only the owner’s photos', async () => {
  for (const describe of [true, false]) {
    const { store } = await subscriber({ describe }),
      p = (await store.profile('u1'))!,
      notes = await store.notesBetween('u1', '2026-10-12', '2026-10-13'),
      plan = await bookPlan(p, 'u1', '2026-10-12', '2026-10-13', notes, {}, {}, { made: '2026-10-13' });
    assert.equal(plan.data.title, 'October 12, 2026 to October 13, 2026');
    // The dates are the title already.
    assert.equal(plan.data.range, '');
    assert.equal(plan.data.versions, '4.5.120 to 4.5.121');
    assert.equal(plan.data.counts, '2 days · 2 notes · 2 photos · 1 voice memo');
    assert.deepEqual(
      plan.images.map((i) => i.key),
      ['media/u1/files/a.jpg', 'media/u1/files/gone.jpg']
    );
    assert.equal(plan.data.chapters.length, 1);
    const [first, second] = plan.data.chapters[0]!.days;
    assert.equal(plan.data.chapters[0]!.name, 'October 2026');
    assert.equal(first!.version, '4.5.120');
    // A note with no place shows the home city, once, in the dateline.
    assert.equal(first!.dateline, 'Monday, October 12, 2026 · Minneapolis, Minnesota');
    assert.deepEqual(
      [first!.date, first!.weather, first!.where],
      ['Monday, October 12', undefined, 'Minneapolis, Minnesota']
    );
    const lake = first!.notes[0]!;
    assert.equal(lake.place, undefined);
    assert.equal(lake.by, undefined);
    assert.deepEqual(lake.blocks, [
      { kind: 'text', lines: [[{ text: 'Lake day.' }]] },
      { kind: 'text', lines: [[{ text: 'A loon, close. ' }, { text: '#lake', tag: true }]] }
    ]);
    assert.deepEqual(
      lake.images.map((i) => i.alt),
      [describe ? 'A loon' : 'A photo', 'A photo']
    );
    assert.deepEqual(lake.audio, [{ label: 'Voice memo', transcript: 'Hello lake' }]);
    assert.deepEqual(lake.files, ['Map.pdf']);
    const car = second!.notes[0]!;
    assert.equal(car.by, 'Added by Claude');
    assert.equal(car.place, 'Duluth, Minnesota');
    // No key or address leaves the worker in the template's data.
    const words = JSON.stringify(plan.data);
    assert.ok(!words.includes('media/') && !words.includes('ada@example.com'));
    assert.ok(!plan.data.colophon.some((line) => line.includes('Open-Meteo')));
    // The cover's strip, the contents' calendar, the month's line and the index.
    assert.deepEqual(plan.data.strip, { total: 2, noted: [0, 1], marks: [{ at: 0, label: 'Oct' }] });
    assert.deepEqual(plan.data.calendar, [
      { label: 'Oct 2026', starts: 4, length: 31, first: 12, last: 13, noted: [12, 13] }
    ]);
    assert.equal(plan.data.chapters[0]!.versions, '4.5.120 to 4.5.121');
    assert.equal(plan.data.chapters[0]!.counts, '2 days · 2 notes · 2 photos · 1 voice memo');
    assert.deepEqual(plan.data.index, {
      tags: [{ name: '#lake', refs: '120' }],
      places: [
        { name: 'Duluth, Minnesota', refs: '121' },
        { name: 'Minneapolis, Minnesota', refs: '120' }
      ],
      short: '4.5'
    });
  }
  const { store } = await subscriber(),
    p = (await store.profile('u1'))!,
    named = await bookPlan(
      p,
      'u1',
      '2026-10-12',
      '2026-10-12',
      await store.notesBetween('u1', '2026-10-12', '2026-10-12'),
      {},
      {},
      { title: '  Lake  ', made: '2026-10-13' }
    );
  assert.equal(named.data.title, 'Lake');
  assert.equal(named.data.range, 'October 12, 2026');
  assert.equal(named.data.versions, '4.5.120');
});

test('photos sit two to a row sharing one height, and a small one is never stretched', () => {
  const made = rows([
    { file: '1.jpg', width: 1600, height: 1067, alt: 'A' },
    { file: '2.jpg', width: 1600, height: 1067 },
    { file: '3.jpg', width: 1200, height: 1600 },
    { file: '4.jpg', width: 160, height: 120 }
  ]);
  assert.deepEqual(
    made.map((r) => r.map((p) => p.file)),
    [
      ['1.jpg', '2.jpg'],
      ['3.jpg', '4.jpg']
    ]
  );
  // The two share the text block, less the gutter.
  const [a, b] = made[0]!;
  assert.ok(Math.abs(a!.w + b!.w + 6 / 72 - 4.55) < 0.01);
  assert.equal(a!.alt, 'A');
  assert.equal(b!.alt, undefined);
  // A tall one and a tiny one: the tiny one's 120px stop the row at 0.6in.
  assert.deepEqual(
    made[1]!.map((p) => p.w),
    [0.45, 0.8]
  );
  const [alone] = rows([{ file: '5.jpg', width: 1200, height: 1600 }]);
  assert.equal(alone![0]!.w, 2.7);
  // On US Letter the notes' column beside the rail is 5.05 inches and a lone
  // photo stands 4 tall.
  const [wide] = rows(
      [
        { file: '1.jpg', width: 2000, height: 1333 },
        { file: '2.jpg', width: 2000, height: 1333 }
      ],
      PAGES.letter
    ),
    [tall] = rows([{ file: '3.jpg', width: 1500, height: 2000 }], PAGES.letter);
  assert.ok(Math.abs(wide![0]!.w + wide![1]!.w + 6 / 72 - 5.05) < 0.01);
  assert.equal(tall![0]!.w, 3);
});

test('a photo is turned upright, shrunk to 1600px on white, and keeps no EXIF', async () => {
  const sideways = await jpeg(3200, 1600, (s) => s.withMetadata({ orientation: 6 })),
    made = (await photo(sideways, 'image/jpeg'))!;
  assert.deepEqual([made.width, made.height], [800, 1600]);
  // US Letter's photos are made larger, for its wider text block.
  const big = (await photo(sideways, 'image/jpeg', PAGES.letter.longest))!;
  assert.deepEqual([big.width, big.height], [1000, 2000]);
  const meta = await sharp(made.body).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.exif, undefined);
  assert.equal(meta.orientation, undefined);
  const clear = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#00000000' } })
      .png()
      .toBuffer(),
    flat = (await photo(clear, 'image/png'))!;
  assert.deepEqual([...(await sharp(flat.body).raw().toBuffer()).subarray(0, 3)], [255, 255, 255]);
  assert.equal(await photo(Buffer.from('not a photo'), 'image/jpeg'), null);
  assert.equal(await photo(Buffer.from('not a photo'), 'image/heic'), null);
});

test('the worker’s self test typesets a PNG and a HEIC through Typst', async () => {
  await selfTest();
});

test('a book renders to a tagged PDF, leaving out and counting a photo that is gone', async () => {
  const { store, objects } = await subscriber(),
    p = (await store.profile('u1'))!,
    plan = await bookPlan(
      p,
      'u1',
      '2026-10-12',
      '2026-10-13',
      await store.notesBetween('u1', '2026-10-12', '2026-10-13'),
      {},
      {},
      { made: '2026-10-13' }
    ),
    read = async (key: string) => (await objects.get(key).catch(() => null))?.body ?? null,
    book = await renderBook(plan, read, { now });
  assert.equal(book.pdf.subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual([book.photos, book.missing, book.warnings], [1, 1, 0]);
  // Title, the days, and the colophon.
  assert.ok(book.pages >= 3);
  assert.ok(book.pdf.includes('/StructTreeRoot'));
  // Every page is 6 by 9 inches (in points), unless the book is on US Letter.
  assert.ok(book.pdf.includes('/MediaBox [0 0 432 648]'));
  const letter = await renderBook({ ...plan, data: { ...plan.data, page: PAGES.letter } }, read, { now });
  assert.ok(letter.pdf.includes('/MediaBox [0 0 612 792]'));
  assert.ok(!letter.pdf.includes('/MediaBox [0 0 432 648]'));
  // Past its deadline, a book stops before it typesets.
  await assert.rejects(renderBook(plan, read, { now, deadline: 10, clock: () => 11 }), /ran out of time/);
});

async function building(from: string, to: string, title?: string, page?: string) {
  const s = await subscriber(),
    logs: Item[] = [];
  await s.store.startExport('u1', 'book-a', now, now + 86400, 'BOOK', {
    from,
    to,
    ...(title ? { title } : {}),
    ...(page ? { page } : {})
  });
  return { ...s, logs, context: { ...s, now, clock: () => now, log: (f: Item) => void logs.push(f) } };
}

test('the export worker builds the book, offers it for a day and logs counts only', async () => {
  const { store, objects, logs, context } = await building('2026-10-12', '2026-10-13', 'Lake');
  assert.equal(await runBook(context, 'u1', 'book-a'), 'ready');
  const row = (await store.export('u1', 'BOOK'))!;
  assert.equal(row.status, 'ready');
  assert.equal(row.export_key, bookKey('u1', 'book-a'));
  assert.equal(row.expires_at, now + 86400);
  assert.deepEqual([row.photos, row.missing], [1, 1]);
  assert.ok(Number(row.pages) >= 3);
  const file = await objects.head(bookKey('u1', 'book-a'));
  assert.equal(file.type, 'application/pdf');
  assert.equal(file.size, row.size);
  // The zip's row is untouched.
  assert.ok(!(await store.export('u1')));
  assert.deepEqual(logs, [
    { event: 'book-built', user: 'u1', size: row.size, seconds: 0, pages: row.pages, photos: 1, missing: 1 }
  ]);
  // Run again (Lambda retries), it is done already.
  assert.equal(await runBook(context, 'u1', 'book-a'), 'skipped');
  assert.equal(await runBook(context, 'u1', 'book-b'), 'skipped');
});

test('the worker sets the book at the page size its row names', async () => {
  const { objects, context } = await building('2026-10-12', '2026-10-13', undefined, 'letter');
  assert.equal(await runBook(context, 'u1', 'book-a'), 'ready');
  const pdf = (await objects.get(bookKey('u1', 'book-a'))).body;
  assert.ok(pdf.includes('/MediaBox [0 0 612 792]'));
});

test('a book whose days hold no notes ends as empty, with no file', async () => {
  const { store, objects, context } = await building('2026-10-01', '2026-10-02');
  assert.equal(await runBook(context, 'u1', 'book-a'), 'empty');
  const row = (await store.export('u1', 'BOOK'))!;
  assert.deepEqual([row.status, row.reason], ['failed', 'empty']);
  assert.ok(!objects.calls.some((c) => c.operation === 'uploadFile'));
});

test('a book for an account being deleted is never built', async () => {
  const { store, objects, context } = await building('2026-10-12', '2026-10-13');
  await store.seed({ ...(await store.profile('u1'))!, deleting: true });
  assert.equal(await runBook(context, 'u1', 'book-a'), 'skipped');
  assert.ok(!objects.calls.some((c) => c.operation === 'get' || c.operation === 'uploadFile'));
});
test('a rich note prints its marks, lists, numbered lists and quotes as it wrote them, with nothing guessed', () => {
  const made = richBlocks([
    'A **long** day at the *lake*.\nPacked:\n- towels\n- the ',
    { tag: 'canoe', text: '#canoe' },
    ' paddles\n  and a bag\n\n3. third\n4. fourth\n\n> cold *water*\n\nRead ',
    { url: 'https://example.com/loons', label: 'Loons', site: 'example.com' },
    '.'
  ]);
  assert.deepEqual(made, [
    {
      kind: 'text',
      lines: [
        [
          { text: 'A ' },
          { text: 'long', strong: true },
          { text: ' day at the ' },
          { text: 'lake', em: true },
          { text: '.' }
        ],
        [{ text: 'Packed:' }]
      ]
    },
    {
      kind: 'list',
      lines: [
        [{ text: 'towels' }],
        [{ text: 'the ' }, { text: '#canoe', tag: true }, { text: ' paddles' }, { text: ' ' }, { text: 'and a bag' }]
      ]
    },
    { kind: 'numbers', lines: [[{ text: 'third' }], [{ text: 'fourth' }]], start: 3 },
    { kind: 'text', lines: [[{ text: 'cold ' }, { text: 'water', em: true }]], quote: true },
    {
      kind: 'text',
      lines: [
        [
          { text: 'Read ' },
          { text: 'Loons', href: 'https://example.com/loons' },
          { text: ' · example.com', muted: true },
          { text: '.' }
        ]
      ]
    }
  ]);
  assert.equal(
    plainText({ blocks: made }),
    'A long day at the lake.\nPacked:\n\n- towels\n- the #canoe paddles and a bag\n\n3. third\n4. fourth\n\n> cold water\n\nRead Loons · example.com.'
  );
});
test('Typst sets a rich note’s bold, italic, numbered list and quote with no warnings', async () => {
  const { store, objects } = await subscriber(),
    p = (await store.profile('u1'))!,
    plan = await bookPlan(
      p,
      'u1',
      '2026-10-12',
      '2026-10-13',
      await store.notesBetween('u1', '2026-10-12', '2026-10-13'),
      {},
      {},
      { made: '2026-10-13' }
    ),
    day = plan.data.chapters[0]!.days[0]!,
    note = { ...day.notes[0]!, blocks: richBlocks(['**Bold**, *italic*.\n\n2. two\n3. three\n\n> a *quote*']) },
    rich = {
      ...plan,
      data: {
        ...plan.data,
        chapters: [{ ...plan.data.chapters[0]!, days: [{ ...day, notes: [note, ...day.notes.slice(1)] }] }]
      }
    },
    read = async (key: string) => (await objects.get(key).catch(() => null))?.body ?? null,
    book = await renderBook(rich, read, { now });
  assert.equal(book.pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(book.warnings, 0);
});
