/** Typesets a book (data.ts) to PDF with Typst, in the export worker. Each
 * photo is read once, turned the right way up and made a JPEG on white no
 * longer than its page size's `longest`, so no EXIF or GPS reaches the PDF; a HEIC is decoded by
 * libheif in WebAssembly first, since Sharp's prebuilt libvips reads none.
 * A photo that is gone or unreadable is left out and counted. Typst sees an
 * empty workspace holding only /data.json and /media/, with the fonts from
 * assets/ and nothing from the host. Typst and Sharp load on first use, so a
 * zip export never pays for them. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countLine, measure, PAGES, type BookData, type BookPhoto, type BookPlan, type Page } from './data.ts';

export const LONGEST = PAGES['6x9'].longest,
  QUALITY = 80,
  MAX_PIXELS = 100_000_000;
const GUTTER = 6 / 72,
  /** No photo is stretched below this many pixels an inch. */
  DPI = 100;
const HEIF = new Set(['image/heic', 'image/heif']);
const FONTS = [
  'BricolageGrotesque-Regular.ttf',
  'BricolageGrotesque-Bold.ttf',
  'BricolageGrotesque-ExtraBold.ttf',
  'MartianMono-Regular.ttf',
  'MartianMono-Bold.ttf',
  'TwemojiMozilla.ttf'
];
const asset = (name: string) => readFile(new URL(`./assets/${name}`, import.meta.url));

export interface Made {
  body: Buffer;
  width: number;
  height: number;
}
/** One photo as the book prints it, or null when it can't be read. */
export async function photo(bytes: Buffer, type: string, longest = LONGEST): Promise<Made | null> {
  const sharp = (await import('sharp')).default;
  try {
    let source;
    if (HEIF.has(type)) {
      const decode = (await import('heic-decode')).default,
        image = await decode({ buffer: bytes });
      if (!image.width || !image.height || image.width * image.height > MAX_PIXELS) return null;
      source = sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
        raw: { width: image.width, height: image.height, channels: 4 }
      });
    } else source = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'none', pages: 1 }).autoOrient();
    const { data, info } = await source
      .resize({ width: longest, height: longest, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { body: data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

/** Photos in rows of two sharing one height across the text block; a lone
 * photo stands on its own, no taller than the page's `one`, and a small one
 * keeps near its own size. Widths in inches. */
export function rows(
  photos: { file: string; alt?: string; width: number; height: number }[],
  page: Page = PAGES['6x9']
): BookPhoto[][] {
  const out: BookPhoto[][] = [],
    width = measure(page),
    // Down, so a row never overruns the text block; the nudge undoes float error.
    round = (n: number) => Math.floor(n * 1000 + 1e-6) / 1000;
  for (let i = 0; i < photos.length; i += 2) {
    const row = photos.slice(i, i + 2),
      ratios = row.map((p) => p.width / p.height);
    let high = row.length === 1 ? Math.min(page.one, width / ratios[0]!) : (width - GUTTER) / (ratios[0]! + ratios[1]!);
    high = Math.min(high, row.length === 1 ? page.one : page.row, ...row.map((p) => p.height / DPI));
    out.push(row.map((p, j) => ({ file: p.file, w: round(high * ratios[j]!), ...(p.alt ? { alt: p.alt } : {}) })));
  }
  return out;
}

export interface Rendered {
  pdf: Buffer;
  pages: number;
  photos: number;
  missing: number;
  warnings: number;
}
/** The PDF for `plan`. `read` fetches a stored photo, null when it is gone;
 * `deadline` (epoch seconds, against `clock`) stops a book that would
 * outrun the worker before it starts typesetting. */
export async function renderBook(
  plan: BookPlan,
  read: (key: string) => Promise<Buffer | null>,
  options: {
    now: number;
    deadline?: number;
    clock?: () => number;
    parallel?: number;
    /** Last words before typesetting, once the photos are made: the
     * commentary, written meanwhile (commentary.ts). */
    finish?: (data: BookData) => Promise<BookData>;
  }
): Promise<Rendered> {
  const clock = options.clock ?? (() => Date.now() / 1000),
    made = new Map<string, Made>();
  let next = 0;
  const work = async () => {
    while (next < plan.images.length) {
      const image = plan.images[next++]!;
      if (options.deadline && clock() > options.deadline) throw new Error('Book photos ran out of time');
      const bytes = await read(image.key),
        done = bytes && (await photo(bytes, image.type, plan.data.page.longest));
      if (done) made.set(image.id, done);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.parallel ?? 2) }, work));
  const pictured: BookData = {
    ...plan.data,
    counts: countLine(plan, made.size),
    chapters: plan.data.chapters.map((c) => ({
      ...c,
      days: c.days.map((d) => ({
        ...d,
        notes: d.notes.map(({ images, ...n }) => ({
          ...n,
          images: [],
          photos: rows(
            images
              .filter((i) => made.has(i.id))
              .map((i) => ({
                file: `${i.id}.jpg`,
                alt: i.alt,
                width: made.get(i.id)!.width,
                height: made.get(i.id)!.height
              })),
            plan.data.page
          )
        }))
      }))
    }))
  };
  const data = options.finish ? await options.finish(pictured) : pictured;
  // A CommonJS package: Node names its exports, a loader may only give default.
  const typst = await import('@myriaddreamin/typst-ts-node-compiler'),
    { NodeCompiler } = typst.NodeCompiler ? typst : (typst as unknown as { default: typeof typst }).default,
    root = await mkdtemp(join(tmpdir(), 'release-book-'));
  const fonts = await Promise.all(FONTS.map((f) => asset(`fonts/${f}`))),
    template = (await asset('book.typ')).toString('utf8');
  try {
    const compiler = NodeCompiler.create({ workspace: root, fontArgs: [{ fontBlobs: fonts }] });
    compiler.mapShadow(join(root, 'data.json'), Buffer.from(JSON.stringify(data)));
    for (const [id, m] of made) compiler.mapShadow(join(root, 'media', `${id}.jpg`), m.body);
    const result = compiler.compile({ mainFileContent: template }),
      warnings = result.takeWarnings()?.shortDiagnostics.length ?? 0;
    if (result.hasError() || !result.result) throw new Error();
    const pdf = compiler.pdf(result.result, { creationTimestamp: options.now, pdfTags: true });
    return {
      pdf,
      pages: result.result.numOfPages,
      photos: made.size,
      missing: plan.images.length - made.size,
      warnings
    };
  } catch {
    // Typst's diagnostics and errors can quote the book's words, so only
    // this leaves here (and a count of warnings, above).
    throw new Error('Book typesetting failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A 16 by 16 pixel HEIC (a synthetic gradient, made with macOS sips), so
 * the deploy probe proves libheif decodes on Lambda. */
const TINY_HEIC =
  'AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABw21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAA' +
  'AAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVp' +
  'bmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAA5mlwcnAAAADF' +
  'aXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAAQAAAAEAAAAAlpcm90AAAAABBwaXhpAAAA' +
  'AAMICAgAAABxaHZjQwEDcAAAALAAAAAAAB7wAPz9+PgAAAsDoAABABdAAQwB//8DcAAAAwCwAAADAAADAB5wJKEAAQAjQgEBA3AA' +
  'AAMAsAAAAwAAAwAeoBQgQcCTDOIe5FlU3AgIGAKiAAEACUQBwGFyyEBTJAAAABlpcG1hAAAAAAAAAAEAAQaBAgMFhoQAAAAsaWxv' +
  'YwAAAABEAAACAAEAAAABAAACQwAAAGQAAgAAAAEAAAH3AAAATAAAAAFtZGF0AAAAAAAAAMAAAAAGRXhpZgAATU0AKgAAAAgAAwEa' +
  'AAUAAAABAAAAMgEbAAUAAAABAAAAOgEoAAMAAAABAAIAAAAAAAAAAAAZAAAAAQAAABkAAAABAAAAYCgBr6N9Rn0chlK+NxX5fNSO' +
  'uobktpkUDShsfhEKWtPaiHClObduCXXPkzLF9AZ7RlaYWBjA/00dH/94hf/rWZI9o/P9FR9lt8ZYnX9T2n1PbE4sxNXf9Y39dUgQ' +
  't34UFw==';
/** The export worker's self-test: a one-day book with a PNG and a HEIC,
 * proving Typst, the fonts, Sharp and libheif load where it runs. */
export async function selfTest(): Promise<void> {
  const sharp = (await import('sharp')).default,
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#1a4fe0' } })
      .png()
      .toBuffer(),
    stored = new Map([
      ['png', png],
      ['heic', Buffer.from(TINY_HEIC, 'base64')]
    ]),
    note = {
      paragraphs: [[[{ text: 'Self test ✓ 🛶' }]]],
      photos: [],
      images: [{ id: '1' }, { id: '2' }],
      audio: [],
      files: []
    },
    made = await renderBook(
      {
        data: {
          page: PAGES['6x9'],
          title: 'Self test',
          range: '',
          versions: '0.0.0',
          counts: '',
          chapters: [
            { name: 'Self test', days: [{ day: '2000-01-01', version: '0.0.0', dateline: 'Self test', notes: [note] }] }
          ],
          colophon: ['Self test.']
        },
        images: [
          { id: '1', key: 'png', type: 'image/png' },
          { id: '2', key: 'heic', type: 'image/heic' }
        ],
        days: 1,
        notes: 1,
        memos: 0
      },
      async (key) => stored.get(key) ?? null,
      { now: 0 }
    );
  if (made.photos !== 2 || made.warnings || made.pages < 2 || made.pdf.subarray(0, 5).toString() !== '%PDF-')
    throw new Error('Book runtime self test failed');
}
