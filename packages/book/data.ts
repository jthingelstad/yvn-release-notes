/** What a Release Notes book holds: one subscriber's notes for a span of
 * days, read as the web reads them (views.dayView), in month chapters. Every
 * word is a string for the template (assets/book.typ) to set as text, never
 * as markup. Photos are listed with their stored keys for the export worker
 * alone; no key leaves it. A photo's alt text is its description only for a
 * subscriber who turned descriptions on, as in the email. */
import type { Item } from '../backend/store-types.ts';
import { dayView } from '../backend/views.ts';
import { longDate } from '../backend/export.ts';
import { CREDIT, CREDIT_URL, fahrenheit, placeOf, summary, type Reading } from '../backend/weather.ts';
import { daysBetween, parseDay } from '../domain/dates.ts';
import type { PlaceRecord } from '../domain/notes.ts';
import { computeVersion, releaseName, releaseSpan } from '../domain/version.ts';
import * as rich from '../domain/rich.ts';
import { MAX_PHOTOS, type PageSize } from './limits.ts';

export { MAX_PHOTOS, MAX_TITLE } from './limits.ts';

/** A page size's geometry in inches: the page, its margins (inside at the
 * binding), the rail a day's version and date hang in beside its notes (none
 * on the 6 by 9, which stacks them) and the gap after it, the tallest lone
 * photo and row of two, the longest side a photo is made at (enough for 300
 * pixels an inch across the text block), and its type scale against the 6
 * by 9's 10.5 point text. */
export interface Page {
  width: number;
  height: number;
  inside: number;
  outside: number;
  top: number;
  bottom: number;
  rail: number;
  gap: number;
  one: number;
  row: number;
  longest: number;
  scale: number;
}
export const PAGES: Record<PageSize, Page> = {
  '6x9': {
    width: 6,
    height: 9,
    inside: 0.8,
    outside: 0.65,
    top: 0.8,
    bottom: 0.85,
    rail: 0,
    gap: 0,
    one: 3.6,
    row: 2.6,
    longest: 1600,
    scale: 1
  },
  letter: {
    width: 8.5,
    height: 11,
    // A rail and a column of about 70 characters, not one line of 95.
    inside: 1,
    outside: 0.75,
    top: 0.9,
    bottom: 0.95,
    rail: 1.45,
    gap: 0.25,
    one: 4,
    row: 2.9,
    longest: 2000,
    scale: 8 / 7
  }
};
/** The text block's width, in inches. */
export const measure = (page: Page): number => page.width - page.inside - page.outside;
/** The notes' column, beside the rail: what a photo is sized to. */
export const column = (page: Page): number => measure(page) - page.rail - page.gap;

export interface BookSpan {
  text: string;
  href?: string;
  tag?: true;
  muted?: true;
  /** Bold or italic, in a note written with rich text (docs/RICH-TEXT.md). */
  strong?: true;
  em?: true;
}
export interface BookPhoto {
  file: string;
  w: number;
  alt?: string;
}
/** A run of a note's lines: a paragraph, list items (written "- ", "* " or
 * "• ", the marker dropped), or a short line heading the list below it. A
 * tight block goes on from the one before, in the same paragraph as written.
 * A note written with rich text also has numbered lists (from `start`) and
 * quoted blocks. */
export interface BookBlock {
  kind: 'text' | 'list' | 'head' | 'numbers';
  lines: BookSpan[][];
  tight?: true;
  start?: number;
  quote?: true;
}
export interface BookNote {
  by?: string;
  blocks: BookBlock[];
  place?: string;
  /** Filled in by the renderer, once the photos are made: rows of photos. */
  photos: BookPhoto[][];
  /** The photos to make, by `BookImage.id`, in order. */
  images: { id: string; alt?: string }[];
  audio: { label: string; transcript?: string }[];
  files: string[];
}
export interface BookDay {
  /** The day, YYYY-MM-DD, for the commentary to name; never printed. */
  day: string;
  version: string;
  /** The date, weather and place in one line, for the commentary. */
  dateline: string;
  /** As printed: the weekday and date, the day's weather, and its place. */
  date: string;
  weather?: string;
  where?: string;
  notes: BookNote[];
  /** Claude's note beside the day, in paragraphs (commentary.ts). */
  annotation?: string[];
}
/** A month as the contents and its opener draw it: the weekday its first
 * falls on (0 is Sunday), its length, the span's first and last day in it,
 * and the days with notes. */
export interface BookMonth {
  label: string;
  starts: number;
  length: number;
  first: number;
  last: number;
  noted: number[];
}
/** An index line: a tag or place, and the releases that hold it. */
export interface BookEntry {
  name: string;
  refs: string;
}
export interface BookChapter {
  name: string;
  days: BookDay[];
  /** Its releases, for the contents and the opener ("5.4.276 to 5.4.294"). */
  versions: string;
  /** Filled in by the renderer, once the photos are made. */
  counts: string;
  month?: BookMonth;
  opening?: string[];
}
export interface BookData {
  page: Page;
  title: string;
  range: string;
  versions: string;
  counts: string;
  /** The title page's figures, filled in by the renderer like `counts`. */
  stats: { n: string; label: string }[];
  /** Every release in the span, the cover's strip: how many, which have
   * notes (from 0), and where each month or year starts. */
  strip: { total: number; noted: number[]; marks: { at: number; label: string }[] };
  /** Months to draw in the contents, when the span is 13 months or less. */
  calendar: BookMonth[];
  /** Claude's introduction and afterword, in paragraphs (commentary.ts). */
  introduction?: string[];
  chapters: BookChapter[];
  afterword?: string[];
  /** Tags and places by release; `short` when every release shares one
   * major.minor, so the refs are patch numbers alone. */
  index: { tags: BookEntry[]; places: BookEntry[]; short?: string };
  colophon: string[];
}
export interface BookImage {
  id: string;
  key: string;
  type: string;
}
export interface BookPlan {
  data: BookData;
  images: BookImage[];
  days: number;
  notes: number;
  memos: number;
}

type Part = string | { url: string; label: string; site?: string } | { tag: string; text: string };
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
/** The title page's last line, once the photos that made it are known. */
export function countLine(plan: Pick<BookPlan, 'days' | 'notes' | 'memos'>, photos: number): string {
  return [
    plural(plan.days, 'day'),
    plural(plan.notes, 'note'),
    ...(photos ? [plural(photos, 'photo')] : []),
    ...(plan.memos ? [plural(plan.memos, 'voice memo')] : [])
  ].join(' · ');
}
/** The title page's figures: days and notes, and photos and voice memos
 * when there are any. */
export function stats(plan: Pick<BookPlan, 'days' | 'notes' | 'memos'>, photos: number): BookData['stats'] {
  const figure = (n: number, one: string, many = one + 's') => ({
    n: n.toLocaleString('en-US'),
    label: n === 1 ? one : many
  });
  return [
    figure(plan.days, 'day'),
    figure(plan.notes, 'note'),
    ...(photos ? [figure(photos, 'photo')] : []),
    ...(plan.memos ? [figure(plan.memos, 'voice memo')] : [])
  ];
}
/** A month's line in the contents and its opener; `photos` counts a note's. */
export function chapterCounts(days: readonly BookDay[], photos: (note: BookNote) => number): string {
  const notes = days.flatMap((d) => d.notes);
  return countLine(
    { days: days.length, notes: notes.length, memos: notes.reduce((sum, n) => sum + n.audio.length, 0) },
    notes.reduce((sum, n) => sum + photos(n), 0)
  );
}
const monthFormat = (style: 'long' | 'short', year: number, month: number) =>
  new Intl.DateTimeFormat('en-US', { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 15)));
const monthName = (day: string) => {
  const { year, month } = parseDay(day);
  return `${monthFormat('long', year, month)} ${year}`;
};
const pad = (n: number) => String(n).padStart(2, '0');
/** The months `from` through `to` touches, with the days `noted` marked. */
function months(from: string, to: string, noted: ReadonlySet<string>): BookMonth[] {
  const out: BookMonth[] = [],
    end = parseDay(to);
  let { year, month } = parseDay(from);
  while (year < end.year || (year === end.year && month <= end.month)) {
    const length = new Date(Date.UTC(year, month, 0)).getUTCDate(),
      prefix = `${year}-${pad(month)}-`;
    out.push({
      label: `${monthFormat('short', year, month)} ${year}`,
      starts: new Date(Date.UTC(year, month - 1, 1)).getUTCDay(),
      length,
      first: from.startsWith(prefix) ? parseDay(from).day : 1,
      last: to.startsWith(prefix) ? end.day : length,
      noted: [...noted].filter((d) => d.startsWith(prefix)).map((d) => parseDay(d).day)
    });
    [year, month] = month === 12 ? [year + 1, 1] : [year, month + 1];
  }
  return out;
}
/** The cover's strip: every release from `from` to `to`, the noted ones
 * marked, and where each month starts (by initial past six months), or
 * each year past thirteen. */
function strip(from: string, to: string, noted: readonly string[]): BookData['strip'] {
  const total = daysBetween(from, to) + 1,
    end = parseDay(to),
    count = (end.year - parseDay(from).year) * 12 + end.month - parseDay(from).month + 1,
    marks: BookData['strip']['marks'] = [];
  let { year, month } = parseDay(from);
  while (year < end.year || (year === end.year && month <= end.month)) {
    const at = Math.max(0, daysBetween(from, `${year}-${pad(month)}-01`)),
      name = monthFormat('short', year, month);
    if (count <= 13) marks.push({ at, label: count > 6 ? name.slice(0, 1) : name });
    else if (month === 1 || !marks.length) marks.push({ at, label: String(year) });
    [year, month] = month === 12 ? [year + 1, 1] : [year, month + 1];
  }
  return { total, noted: noted.map((d) => daysBetween(from, d)), marks };
}
/** The index: each name, by the releases that hold it, in book order. */
function indexOf(found: Map<string, { name: string; versions: string[] }>, short: string | undefined): BookEntry[] {
  return [...found.values()]
    .sort((a, b) => a.name.replace(/^#/, '').localeCompare(b.name.replace(/^#/, ''), 'en', { sensitivity: 'base' }))
    .map(({ name, versions }) => ({
      name,
      refs:
        versions.length > 8
          ? plural(versions.length, 'day')
          : versions.map((v) => (short ? v.slice(short.length + 1) : v)).join(' · ')
    }));
}
function enter(found: Map<string, { name: string; versions: string[] }>, name: string, version: string) {
  const key = name.toLowerCase(),
    entry = found.get(key) ?? { name, versions: [] };
  if (entry.versions.at(-1) !== version) entry.versions.push(version);
  found.set(key, entry);
}
const web = (url: string) => /^https?:\/\//i.test(url);
const bare = (site: string) => site.toLowerCase().replace(/^www\./, '');

/** A note's words as paragraphs of lines of spans: a blank line starts a
 * paragraph and a single newline breaks the line, as the note was written. */
export function paragraphs(parts: readonly Part[]): BookSpan[][][] {
  const lines: BookSpan[][] = [[]];
  for (const part of parts) {
    if (typeof part === 'string')
      part
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .forEach((piece, i) => {
          if (i) lines.push([]);
          if (piece) lines.at(-1)!.push({ text: piece });
        });
    else if ('tag' in part) lines.at(-1)!.push({ text: part.text, tag: true });
    else {
      lines.at(-1)!.push(web(part.url) ? { text: part.label, href: part.url } : { text: part.label });
      // The site, unless the link's name says it already.
      if (part.site && !bare(part.label).includes(bare(part.site)))
        lines.at(-1)!.push({ text: ` · ${part.site}`, muted: true });
    }
  }
  const out: BookSpan[][][] = [];
  let paragraph: BookSpan[][] = [];
  for (const raw of lines) {
    const line = raw.map((s) => ({ ...s }));
    if (line.length) {
      line[0]!.text = line[0]!.text.trimStart();
      line.at(-1)!.text = line.at(-1)!.text.trimEnd();
    }
    const kept = line.filter((s) => s.text);
    if (kept.length) paragraph.push(kept);
    else if (paragraph.length) {
      out.push(paragraph);
      paragraph = [];
    }
  }
  if (paragraph.length) out.push(paragraph);
  return out;
}

const MARKER = /^[-*•]\s+/,
  HEAD = 60;
const words = (line: BookSpan[]) => line.map((s) => s.text).join('');
/** Paragraphs (above) as blocks: a line written as a list item joins the
 * list around it, and a short line with no closing stop just before a list
 * heads it. Everything else stays the paragraph it was. */
export function blocks(written: BookSpan[][][]): BookBlock[] {
  const flat = written
    .flatMap((p, at) =>
      p.map((line) => {
        const first = line[0]!,
          marked = !first.href && !first.tag && !first.muted && MARKER.test(first.text);
        if (!marked) return { at, kind: 'text' as BookBlock['kind'], line };
        const rest = [{ ...first, text: first.text.replace(MARKER, '') }, ...line.slice(1)].filter((s) => s.text);
        return { at, kind: 'list' as BookBlock['kind'], line: rest };
      })
    )
    .filter((l) => l.line.length);
  flat.forEach((l, i) => {
    const text = words(l.line).trim();
    if (l.kind === 'text' && flat[i + 1]?.kind === 'list' && text.length <= HEAD && !/[.!?;,…]$/.test(text))
      l.kind = 'head';
  });
  const out: BookBlock[] = [];
  let last = -1;
  for (const l of flat) {
    const open = out.at(-1);
    if (open && l.at === last && l.kind === open.kind && l.kind !== 'head') open.lines.push(l.line);
    else out.push({ kind: l.kind, lines: [l.line], ...(l.at === last ? { tight: true as const } : {}) });
    last = l.at;
  }
  return out;
}
type Atom = Exclude<Part, string>;
/** One line of a rich note as spans, each with its marks (a link's site
 * unmarked), trimmed as paragraphs() trims. */
function richLine(line: rich.Line<Atom>): BookSpan[] {
  const out: BookSpan[] = [];
  for (const bit of line) {
    const marks = { ...(bit.strong ? { strong: true as const } : {}), ...(bit.em ? { em: true as const } : {}) };
    if ('text' in bit) out.push({ text: bit.text, ...marks });
    else if ('tag' in bit.atom) out.push({ text: bit.atom.text, tag: true, ...marks });
    else {
      const a = bit.atom;
      out.push(web(a.url) ? { text: a.label, href: a.url, ...marks } : { text: a.label, ...marks });
      if (a.site && !bare(a.label).includes(bare(a.site))) out.push({ text: ` · ${a.site}`, muted: true });
    }
  }
  if (out.length) {
    out[0] = { ...out[0]!, text: out[0]!.text.trimStart() };
    out[out.length - 1] = { ...out.at(-1)!, text: out.at(-1)!.text.trimEnd() };
  }
  return out.filter((s) => s.text);
}
/** A note written with rich text as blocks: its paragraphs, lists, numbered
 * lists and quotes as it marked them (domain/rich.ts), with nothing guessed.
 * A list item's lines run on as one; a quote's blocks are marked quoted. */
export function richBlocks(parts: readonly Part[]): BookBlock[] {
  const out: BookBlock[] = [];
  const add = (written: rich.Block<Atom>[], quote: boolean) => {
    for (const b of written) {
      const q = quote ? { quote: true as const } : {};
      if (b.kind === 'quote') add(b.blocks, true);
      else if (b.kind === 'para')
        out.push({ kind: 'text', lines: b.lines.map(richLine).filter((l) => l.length), ...q });
      else
        out.push({
          kind: b.kind === 'numbers' ? 'numbers' : 'list',
          lines: b.items
            .map((rows) => rows.map(richLine).filter((l) => l.length))
            .map((rows) => rows.flatMap((l, i) => (i ? [{ text: ' ' }, ...l] : l)))
            .filter((l) => l.length),
          ...(b.kind === 'numbers' && b.start !== 1 ? { start: b.start } : {}),
          ...q
        });
    }
  };
  add(rich.blocks(parts), false);
  return out.filter((b) => b.lines.length);
}
/** A note's words as written, from its blocks: for the commentary to read. */
export const plainText = (note: Pick<BookNote, 'blocks'>): string =>
  note.blocks
    .map((b, i) => {
      const text = b.lines
        .map(
          (line, j) =>
            (b.quote ? '> ' : '') +
            (b.kind === 'list' ? '- ' : b.kind === 'numbers' ? `${(b.start ?? 1) + j}. ` : '') +
            words(line)
        )
        .join('\n');
      return i === 0 ? text : (b.tight ? '\n' : '\n\n') + text;
    })
    .join('');

/** The title a book gets unless its maker names one: the release's name for
 * a whole year of life, else the span's dates. */
export function defaultTitle(birthday: string, from: string, to: string): string {
  const age = computeVersion(birthday, from).age,
    [first, last] = releaseSpan(birthday, age);
  if (from === first && to <= last && computeVersion(birthday, to).age === age) return releaseName(age);
  return span(from, to);
}
export function span(from: string, to: string): string {
  const a = longDate(from).split(', ').slice(1).join(', '),
    b = longDate(to).split(', ').slice(1).join(', ');
  return from === to ? a : `${a} to ${b}`;
}

/** The book for `from` through `to`, from that span's notes, weather and day
 * places. `notes` are the raw items (store.notesBetween). */
export async function bookPlan(
  p: Item,
  uid: string,
  from: string,
  to: string,
  notes: Item[],
  sky: Record<string, Item>,
  own: Record<string, Item>,
  options: { title?: string | null; made: string; page?: PageSize }
): Promise<BookPlan> {
  const byDay = new Map<string, Item[]>();
  for (const n of notes) {
    const day = String(n.sk).split('#')[1]!;
    if (day >= from && day <= to) byDay.set(day, [...(byDay.get(day) ?? []), n]);
  }
  const images: BookImage[] = [],
    chapters: BookData['chapters'] = [],
    describe = Boolean(p.describe);
  const noted: string[] = [],
    tags = new Map<string, { name: string; versions: string[] }>(),
    places = new Map<string, { name: string; versions: string[] }>();
  let weather = false,
    noteCount = 0,
    audio = 0;
  for (const day of [...byDay.keys()].sort()) {
    const raw = byDay.get(day)!,
      view = await dayView(p, day, raw, sky[day], undefined, own[day]),
      shown = view.notes as Item[],
      kept: BookNote[] = [];
    let city = typeof view.where === 'string' ? view.where : '';
    shown.forEach((n, i) => {
      const item = raw[i]!,
        media = (Array.isArray(item.media) ? item.media : []) as Item[],
        note: BookNote = {
          blocks: rich.isRich(n)
            ? richBlocks((n.parts as Part[]) ?? [])
            : blocks(paragraphs((n.parts as Part[]) ?? [])),
          photos: [],
          images: [],
          audio: [],
          files: []
        };
      if (n.author === 'assistant') note.by = `Added by ${n.client || 'an agent'}`;
      if (typeof n.place === 'string') {
        if (n.place_from) city ||= n.place;
        else note.place = n.place;
      }
      for (const m of (n.media as Item[] | undefined) ?? []) {
        const stored = media.find((s) => Number(s.n) === Number(m.n));
        if (m.kind === 'image') {
          const key = String(stored?.key ?? '');
          if (!key.startsWith(`media/${uid}/`) || images.length >= MAX_PHOTOS) continue;
          const id = String(images.length + 1);
          images.push({ id, key, type: String(m.type ?? '') });
          note.images.push({
            id,
            alt: describe && typeof m.description === 'string' && m.description ? m.description : 'A photo'
          });
        } else if (m.kind === 'audio') {
          audio++;
          note.audio.push({
            label: 'Voice memo',
            ...(typeof m.transcript === 'string' && m.transcript ? { transcript: m.transcript } : {})
          });
        } else note.files.push(typeof m.name === 'string' && m.name ? m.name : 'A PDF');
      }
      if (n.attachments) note.files.push(plural(Number(n.attachments), 'other file'));
      if (note.blocks.length || note.images.length || note.audio.length || note.files.length) kept.push(note);
    });
    if (!kept.length) continue;
    const reading = view.weather ? (sky[day] as Reading) : null,
      // The weather's town, else the day's place, printed once by the date.
      where = (typeof reading?.city === 'string' && reading.city) || city,
      version = String(view.version);
    // A note's place is left out when it is the day's.
    for (const note of kept)
      if (note.place && (note.place === city || note.place === where || note.place.split(', ')[0] === where))
        delete note.place;
    noteCount += kept.length;
    if (view.weather) weather = true;
    noted.push(day);
    if (where) enter(places, where, version);
    for (const n of kept) {
      if (n.place) enter(places, n.place, version);
      for (const b of n.blocks)
        for (const line of b.lines) for (const s of line) if (s.tag) enter(tags, s.text, version);
    }
    const dateline = [longDate(day), view.weather ? String(view.weather) : city].filter(Boolean).join(' · '),
      name = monthName(day);
    if (chapters.at(-1)?.name !== name) chapters.push({ name, days: [], versions: '', counts: '' });
    chapters.at(-1)!.days.push({
      day,
      version,
      dateline,
      date: longDate(day).replace(/, \d+$/, ''),
      ...(reading ? { weather: summary(reading, fahrenheit(placeOf(p) ?? (reading as PlaceRecord))) } : {}),
      ...(where ? { where } : {}),
      notes: kept
    });
  }
  const noting = new Set(noted),
    calendar = months(from, to, noting),
    first = computeVersion(String(p.birthday), from),
    last = computeVersion(String(p.birthday), to),
    short = first.major === last.major && first.minor === last.minor ? `${first.major}.${first.minor}` : undefined;
  for (const c of chapters) {
    const a = c.days[0]!.version,
      b = c.days.at(-1)!.version;
    c.versions = a === b ? a : `${a} to ${b}`;
    c.counts = chapterCounts(c.days, (n) => n.images.length);
    const at = parseDay(c.days[0]!.day),
      start = parseDay(from);
    c.month = calendar[(at.year - start.year) * 12 + at.month - start.month];
  }
  const days = chapters.reduce((sum, c) => sum + c.days.length, 0),
    birthday = String(p.birthday),
    title = options.title?.trim() || defaultTitle(birthday, from, to),
    range = span(from, to),
    tally = { days, notes: noteCount, memos: audio };
  return {
    data: {
      page: PAGES[options.page ?? '6x9'],
      title,
      // The dates, unless they are the title already.
      range: title === range ? '' : range,
      versions:
        from === to
          ? computeVersion(birthday, from).toString()
          : `${computeVersion(birthday, from).toString()} to ${computeVersion(birthday, to).toString()}`,
      counts: countLine(tally, images.length),
      stats: stats(tally, images.length),
      strip: strip(from, to, noted),
      calendar: calendar.length <= 13 ? calendar : [],
      chapters,
      index: { tags: indexOf(tags, short), places: indexOf(places, short), ...(short ? { short } : {}) },
      colophon: [
        `Made with Release Notes (notes.yourversionnumber.com) on ${longDate(options.made)}.`,
        'Set in Bricolage Grotesque and Martian Mono, under the SIL Open Font License. Emoji from Twemoji by Twitter, Inc. and contributors, CC BY 4.0, in Mozilla’s Twemoji font.',
        ...(weather ? [`${CREDIT} (${CREDIT_URL.replace(/^https:\/\/|\/$/g, '')}), CC BY 4.0.`] : [])
      ]
    },
    images,
    ...tally
  };
}
