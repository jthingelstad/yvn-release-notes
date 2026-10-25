/** What a Release Notes book holds: one subscriber's notes for a span of
 * days, read as the web reads them (views.dayView), in month chapters. Every
 * word is a string for the template (assets/book.typ) to set as text, never
 * as markup. Photos are listed with their stored keys for the export worker
 * alone; no key leaves it. A photo's alt text is its description only for a
 * subscriber who turned descriptions on, as in the email. */
import type { Item } from '../backend/store-types.ts';
import { dayView } from '../backend/views.ts';
import { longDate } from '../backend/export.ts';
import { CREDIT, CREDIT_URL } from '../backend/weather.ts';
import { parseDay } from '../domain/dates.ts';
import { computeVersion, releaseName, releaseSpan } from '../domain/version.ts';
import { MAX_PHOTOS } from './limits.ts';

export { MAX_PHOTOS, MAX_TITLE } from './limits.ts';

export interface BookSpan {
  text: string;
  href?: string;
  tag?: true;
  muted?: true;
}
export interface BookPhoto {
  file: string;
  w: number;
  alt?: string;
}
export interface BookNote {
  by?: string;
  paragraphs: BookSpan[][][];
  place?: string;
  /** Filled in by the renderer, once the photos are made: rows of photos. */
  photos: BookPhoto[][];
  /** The photos to make, by `BookImage.id`, in order. */
  images: { id: string; alt?: string }[];
  audio: { label: string; transcript?: string }[];
  files: string[];
}
export interface BookDay {
  version: string;
  dateline: string;
  notes: BookNote[];
}
export interface BookData {
  title: string;
  range: string;
  versions: string;
  counts: string;
  chapters: { name: string; days: BookDay[] }[];
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
const monthName = (day: string) => {
  const { year, month } = parseDay(day);
  return `${new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 15)))} ${year}`;
};
const web = (url: string) => /^https?:\/\//i.test(url);

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
      if (part.site) lines.at(-1)!.push({ text: ` · ${part.site}`, muted: true });
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
  options: { title?: string | null; made: string }
): Promise<BookPlan> {
  const byDay = new Map<string, Item[]>();
  for (const n of notes) {
    const day = String(n.sk).split('#')[1]!;
    if (day >= from && day <= to) byDay.set(day, [...(byDay.get(day) ?? []), n]);
  }
  const images: BookImage[] = [],
    chapters: BookData['chapters'] = [],
    describe = Boolean(p.describe);
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
          paragraphs: paragraphs((n.parts as Part[]) ?? []),
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
      if (note.paragraphs.length || note.images.length || note.audio.length || note.files.length) kept.push(note);
    });
    if (!kept.length) continue;
    for (const note of kept) if (note.place === city) delete note.place;
    noteCount += kept.length;
    if (view.weather) weather = true;
    const dateline = [longDate(day), view.weather ? String(view.weather) : city].filter(Boolean).join(' · '),
      name = monthName(day);
    if (chapters.at(-1)?.name !== name) chapters.push({ name, days: [] });
    chapters.at(-1)!.days.push({ version: String(view.version), dateline, notes: kept });
  }
  const days = chapters.reduce((sum, c) => sum + c.days.length, 0),
    birthday = String(p.birthday),
    title = options.title?.trim() || defaultTitle(birthday, from, to),
    range = span(from, to),
    tally = { days, notes: noteCount, memos: audio };
  return {
    data: {
      title,
      // The dates, unless they are the title already.
      range: title === range ? '' : range,
      versions:
        from === to
          ? computeVersion(birthday, from).toString()
          : `${computeVersion(birthday, from).toString()} to ${computeVersion(birthday, to).toString()}`,
      counts: countLine(tally, images.length),
      chapters,
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
