/** Day One ZIPs become plans only, never writes. Notes keep their original
 * entry JSON, own timezone, writer link names/tags, ordered files and precise
 * places. ZIP members are bounded and read in place, never extracted; only
 * top-level journal JSON and canonical photos/audios/pdfs paths can be read. */
import * as yauzl from 'yauzl';
import type { Item } from './store.ts';
import type { PlaceRecord, NoteRecord } from '../domain/notes.ts';
import { MAX_NOTE } from '../domain/notes.ts';
import { computeVersion } from '../domain/version.ts';
import { localDay, parseDay } from '../domain/dates.ts';
import { codePointLength, codePointSlice, pythonTrim, pythonRstrip } from '../domain/unicode.ts';
import * as tags from '../domain/tags.ts';
import { urls } from './links.ts';
import { object, rounded } from './places.ts';
import type { WeatherPlace } from './weather.ts';
export const APP = 'dayone',
  MAIN_JOURNAL = 'Journal',
  NEAR_KM = 5,
  DIGITS = 6,
  MAX_JSON = 512 * 1024 * 1024,
  MAX_FILE = 512 * 1024 * 1024,
  MAX_MEMBERS = 100_000;
export const ZONES: Record<string, string> = {
  'US/Central': 'America/Chicago',
  'US/Eastern': 'America/New_York',
  'US/Mountain': 'America/Denver',
  'US/Pacific': 'America/Los_Angeles',
  'Europe/Kiev': 'Europe/Kyiv'
};
export const FILE_NAME = /^(photos|audios|pdfs)\/([0-9A-Za-z]+)\.([0-9A-Za-z]{1,8})$/;
export const FILE_KINDS: Record<string, Record<string, readonly [string, string, string]>> = {
  photos: {
    jpeg: ['image', 'image/jpeg', 'jpg'],
    jpg: ['image', 'image/jpeg', 'jpg'],
    png: ['image', 'image/png', 'png'],
    heic: ['image', 'image/heic', 'heic'],
    gif: ['image', 'image/gif', 'gif']
  },
  audios: {
    m4a: ['audio', 'audio/mp4', 'm4a'],
    aac: ['audio', 'audio/mp4', 'm4a'],
    mp3: ['audio', 'audio/mpeg', 'mp3'],
    wav: ['audio', 'audio/wav', 'wav']
  },
  pdfs: { pdf: ['file', 'application/pdf', 'pdf'] }
};
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}
const array = (value: unknown): Item[] =>
  Array.isArray(value) ? value.filter((v): v is Item => object(v) !== null) : [];
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const word = '\\p{L}\\p{N}_';
const BOLD = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g;
const ITALIC = new RegExp(
  `(?<![${word}*])\\*(?=\\S)([^*\\n]+?)(?<=\\S)\\*(?![${word}*])|(?<![${word}])_(?=\\S)([^_\\n]+?)(?<=\\S)_(?![${word}])`,
  'gu'
);
export function plain(
  markdown: string,
  entryUrl: (uuid: string) => string | null = () => null
): [string, Record<string, string>, Record<string, number>] {
  const held: string[] = [],
    named: Record<string, string> = {},
    counts: Record<string, number> = Object.fromEntries(
      ['photo_markers', 'headings', 'emphasis', 'escapes', 'links', 'entry_links', 'app_links', 'bullets', 'html'].map(
        (k) => [k, 0]
      )
    );
  const hold = (value: string) => {
    held.push(value);
    return `\ue000${held.length - 1}\ue001`;
  };
  const putBack = (value: string) => {
    let text = value;
    while (text.includes('\ue000')) text = text.replace(/\ue000(\d+)\ue001/g, (_, n: string) => held[Number(n)] ?? '');
    return text;
  };
  const words = (value: string) =>
    putBack(value)
      .replace(BOLD, '$2')
      .replace(ITALIC, (_, a: string, b: string) => a || b);
  let t = markdown.replace(/\r\n/g, '\n').replace(/[\ue000\ue001]/g, '');
  const sub = (pattern: RegExp, field: string, replacement: (...args: string[]) => string) => {
    t = t.replace(pattern, (...args) => {
      counts[field] = (counts[field] ?? 0) + 1;
      return replacement(...(args as string[]));
    });
  };
  sub(/!\[[^\]]*\]\(dayone-moment:[^)]*\)/g, 'photo_markers', () => '');
  t = t.replace(/<(https?:\/\/[^\s<>]+)>/g, '$1');
  sub(/<br\s*\/?>/gi, 'html', () => '\n');
  sub(/<\/?(?:strike|s|del|u|b|i|em|strong)\s*\/?>/gi, 'html', () => '');
  sub(/\\([\\`*_{}[\]()#+\-.!>|~])/g, 'escapes', (_, char) => hold(char));
  sub(/(?<!!)\[([^\]\n]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g, 'links', (_, label, url) => {
    const clean = pythonTrim(label!);
    named[putBack(url!)] ??= words(clean);
    return `${clean} ${hold(`<${url}>`)}`;
  });
  t = t.replace(/(?<!!)\[([^\]\n]+)\]\((dayone2?:\/\/[^)\s]*)\)/g, (_, label: string, url: string) => {
    const match = /entryId=([0-9A-Fa-f]{32})/.exec(url),
      resolved = match ? entryUrl(match[1]!.toUpperCase()) : null;
    if (!resolved) {
      counts.app_links!++;
      return pythonTrim(label);
    }
    counts.entry_links!++;
    const clean = pythonTrim(label);
    named[resolved] ??= words(clean);
    return `${clean} ${hold(`<${resolved}>`)}`;
  });
  t = t.replace(/https?:\/\/[^\s<>"]+/g, (value) => hold(value));
  sub(/^[ \t]*#{1,6}[ \t]+/gm, 'headings', () => '');
  sub(BOLD, 'emphasis', (_, __, body) => body!);
  sub(ITALIC, 'emphasis', (_, a, b) => a || b!);
  sub(/^([ \t]*)[*+][ \t]+/gm, 'bullets', (_, indent) => `${indent}- `);
  t = pythonTrim(
    putBack(t)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
  );
  return [t, named, counts];
}
export const zone = (entry: Item) => (ZONES[str(entry.timeZone)] ?? str(entry.timeZone)) || 'UTC';
export function written(entry: Item): number {
  const value = Date.parse(str(entry.creationDate));
  if (!Number.isFinite(value)) throw new ExportError('Invalid entry timestamp');
  return value / 1000;
}
export const dayOf = (entry: Item) => localDay(written(entry), zone(entry));
export function placeOf(location: Item): PlaceRecord | null {
  if (location.latitude == null || location.longitude == null) return null;
  const lat = Number(location.latitude),
    lon = Number(location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw new ExportError('Invalid entry coordinates');
  const label = pythonTrim(str(location.userLabel)),
    found = pythonTrim(str(location.placeName)),
    city = pythonTrim(str(location.localityName)),
    address = /^\d+(?:\s?[–-]\s?\d+)?\s+\S/u.test(found),
    radius = object(location.region)?.radius;
  const out: PlaceRecord = {
    label,
    venue: address || [label, city].includes(found) ? '' : found,
    address: address ? found : '',
    city,
    region: pythonTrim(str(location.administrativeArea)),
    country: pythonTrim(str(location.country)),
    lat: rounded(lat, DIGITS),
    lon: rounded(lon, DIGITS),
    accuracy_m: radius ? rounded(Number(radius)) : null
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== '' && v !== null));
}
function km(a: PlaceRecord, b: PlaceRecord) {
  const rad = (v: unknown) => (Number(v) * Math.PI) / 180,
    la1 = rad(a.lat),
    lo1 = rad(a.lon),
    la2 = rad(b.lat),
    lo2 = rad(b.lon),
    h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function nearest(point: PlaceRecord, places: PlaceRecord[]): PlaceRecord | null {
  const best = places.reduce<PlaceRecord | null>(
    (best, p) => (!best || km(point, p) < km(point, best) ? p : best),
    null
  );
  return best && km(point, best) <= NEAR_KM ? best : null;
}
export function homePlace(profile: Item): PlaceRecord | null {
  if (profile.lat == null || profile.lon == null) return null;
  return Object.fromEntries(
    Object.entries({
      city: profile.city || '',
      region: profile.region || '',
      country: profile.country || '',
      lat: rounded(Number(profile.lat), DIGITS),
      lon: rounded(Number(profile.lon), DIGITS)
    }).filter(([, v]) => v !== '')
  );
}
export function byMd5(names: Iterable<string>) {
  const out = new Map<string, string>();
  for (const name of names) {
    const m = FILE_NAME.exec(name);
    if (m) out.set(`${m[1]}/${m[2]}`, name);
  }
  return out;
}
export function filesOf(entry: Item, index: Map<string, string>): [Item[], string[]] {
  const found: Item[] = [],
    missing: string[] = [];
  for (const [folder, field] of [
    ['photos', 'photos'],
    ['audios', 'audios'],
    ['pdfs', 'pdfAttachments']
  ] as const) {
    for (const file of array(entry[field]).toSorted(
      (a, b) => Number(a.orderInEntry ?? 0) - Number(b.orderInEntry ?? 0)
    )) {
      const path = index.get(`${folder}/${str(file.md5)}`),
        ext = path?.split('.').at(-1)?.toLowerCase(),
        kind = ext ? FILE_KINDS[folder]?.[ext] : null;
      if (!kind) {
        missing.push(str(file.md5) || '?');
        continue;
      }
      const item: Item = { kind: kind[0], type: kind[1], ext: kind[2], from: path };
      if (file.width && file.height)
        Object.assign(item, { width: Math.trunc(Number(file.width)), height: Math.trunc(Number(file.height)) });
      if (file.duration) item.duration = rounded(Number(file.duration), 1);
      if (file.date) item.taken_at = file.date;
      const spot = placeOf(object(file.location) ?? {});
      if (spot) item.place = spot;
      if (folder === 'pdfs' && file.pdfName) item.name = `${file.pdfName}.pdf`;
      found.push(item);
    }
  }
  return [found, missing];
}
export interface PlannedNote {
  date: string;
  id: string;
  item: NoteRecord;
  named: Record<string, string>;
  tag_line: string;
  place_from: string;
  files: Array<{ from: string; key: string; type: string }>;
  original: Item;
  zone_was: unknown;
  urls: string[];
  all_day: boolean;
  starred: boolean;
  modified: unknown;
}
export interface Plan {
  journal: string;
  notes: PlannedNote[];
  skipped: Array<{ date: string; uuid: string; why: string }>;
  missing_files: number;
  counts: Record<string, number>;
  place_from: Record<string, number>;
  weather_days: Record<string, WeatherPlace>;
}
export const goodId = (entry: Item) => typeof entry.uuid === 'string' && /^[0-9A-Fa-f]{32}$/.test(entry.uuid);
const TOWN = ['city', 'region', 'country'];
export function plan(
  journal: string,
  rawEntries: Item[],
  names: Record<string, number>,
  profile: Item,
  user: string,
  webOrigin = 'https://notes.yourversionnumber.com'
): Plan {
  const born = str(profile.birthday);
  parseDay(born);
  if (!/^[A-Za-z0-9-]{1,80}$/.test(user)) throw new ExportError('Invalid subscriber identity');
  const home = homePlace(profile),
    skipped = rawEntries
      .filter((e) => !goodId(e))
      .map((e) => ({
        date: '',
        uuid: codePointSlice(e.uuid == null ? 'None' : String(e.uuid), 0, 40),
        why: 'bad id'
      }));
  const entries = rawEntries.filter(goodId),
    index = byMd5(Object.keys(names)),
    days = new Map(entries.map((e) => [str(e.uuid).toUpperCase(), dayOf(e)]));
  const entryUrl = (uuid: string) => (days.has(uuid) ? `${webOrigin}/day/?d=${days.get(uuid)}` : null);
  const towns = entries.map((e) => placeOf(object(e.location) ?? {})).filter((p): p is PlaceRecord => !!p?.city),
    where = new Map<string, [PlaceRecord | null, string]>();
  for (const e of entries) {
    const own = placeOf(object(e.location) ?? {});
    if (own) {
      where.set(str(e.uuid), [own, 'entry']);
      continue;
    }
    const pic =
      array(e.photos)
        .map((f) => placeOf(object(f.location) ?? {}))
        .find(Boolean) ?? null;
    if (pic && !pic.city) {
      const near = nearest(pic, towns);
      if (near) for (const field of TOWN) if (field in near) pic[field] = near[field];
    }
    where.set(str(e.uuid), pic ? [pic, 'photo'] : [null, '']);
  }
  const sorted = entries.toSorted((a, b) =>
      str(a.creationDate) < str(b.creationDate) ? -1 : str(a.creationDate) > str(b.creationDate) ? 1 : 0
    ),
    dayPlaces = new Map<string, PlaceRecord>();
  for (const e of sorted) {
    const p = where.get(str(e.uuid))![0];
    if (p && !dayPlaces.has(dayOf(e))) dayPlaces.set(dayOf(e), p);
  }
  const notes: PlannedNote[] = [],
    counts: Record<string, number> = {},
    placeFrom: Record<string, number> = {};
  let missingFiles = 0;
  for (const e of sorted) {
    const day = dayOf(e);
    let [text, named, c] = plain(str(e.text), entryUrl);
    for (const [k, v] of Object.entries(c)) counts[k] = (counts[k] ?? 0) + v;
    const [files, missing] = filesOf(e, index);
    missingFiles += missing.length;
    const other = array(e.videos).length;
    if (other) counts.files_not_carried = (counts.files_not_carried ?? 0) + other;
    if (pythonTrim(text.split('\n')[0] ?? '') === 'Day One Essentials Guide') {
      skipped.push({ date: day, uuid: str(e.uuid), why: "day one's own" });
      continue;
    }
    if (!text && !files.length) {
      skipped.push({ date: day, uuid: str(e.uuid), why: other ? 'files not carried' : 'empty' });
      continue;
    }
    const line = tags.line([
        ...(Array.isArray(e.tags) ? e.tags.map(String) : []),
        ...(journal === MAIN_JOURNAL ? [] : [journal])
      ]),
      room = MAX_NOTE - (line ? codePointLength(line) + 2 : 0);
    if (room < 0) throw new ExportError('Entry tags exceed note limit');
    if (codePointLength(text) > room) {
      counts.cut = (counts.cut ?? 0) + 1;
      text = pythonRstrip(codePointSlice(text, 0, Math.max(room, 0)));
    }
    if (line) text = text ? `${text}\n\n${line}` : line;
    let [place, source] = where.get(str(e.uuid))!;
    if (!place && dayPlaces.has(day)) {
      place = dayPlaces.get(day)!;
      source = 'day';
    }
    if (!place && home) {
      place = home;
      source = 'home';
    }
    placeFrom[source || 'none'] = (placeFrom[source || 'none'] ?? 0) + 1;
    const noteId = `d1-${e.uuid}`,
      item: NoteRecord = {
        version: String(computeVersion(born, day)),
        text,
        source: 'import',
        origin: { app: APP, journal, id: e.uuid },
        written_at: new Date(written(e) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        tz: zone(e),
        raw_key: `raw/${APP}/${user}/${e.uuid}.json`
      };
    if (place) item.place = { ...place, from: source };
    const found = tags.found(text);
    if (found.length) item.tags = found;
    const media: Item[] = [],
      copies: PlannedNote['files'] = [];
    for (const [i, f] of files.entries()) {
      const n = i + 1,
        key = `media/${user}/${day}/${noteId}/${n}.${f.ext}`;
      media.push({
        n,
        ...Object.fromEntries(Object.entries(f).filter(([k]) => !['ext', 'from'].includes(k))),
        size: names[str(f.from)],
        key
      });
      copies.push({ from: str(f.from), key, type: str(f.type) });
    }
    if (media.length) item.media = media;
    notes.push({
      date: day,
      id: noteId,
      item,
      named,
      tag_line: line,
      place_from: source,
      files: copies,
      original: e,
      zone_was: e.timeZone ?? null,
      urls: urls(text),
      all_day: Boolean(e.isAllDay),
      starred: Boolean(e.starred),
      modified: e.modifiedDate ?? null
    });
  }
  return {
    journal,
    notes,
    skipped,
    missing_files: missingFiles,
    counts,
    place_from: placeFrom,
    weather_days: weatherDays(notes)
  };
}
export function weatherDays(notes: PlannedNote[]): Record<string, WeatherPlace> {
  const out: Record<string, WeatherPlace> = {};
  for (const home of [false, true])
    for (const n of notes.toSorted((a, b) =>
      String(a.item.written_at) < String(b.item.written_at)
        ? -1
        : String(a.item.written_at) > String(b.item.written_at)
          ? 1
          : 0
    )) {
      const p = n.item.place;
      if (p && !out[n.date] && (n.place_from === 'home') === home)
        out[n.date] = {
          ...Object.fromEntries(TOWN.filter((k) => k in p).map((k) => [k, p[k]])),
          lat: rounded(Number(p.lat), 2),
          lon: rounded(Number(p.lon), 2),
          tz: String(n.item.tz)
        };
    }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
export function journalName(names: string[]): string {
  const name = names.find((n) => n.endsWith('.json') && !n.includes('/'));
  if (!name) throw new ExportError('no journal JSON at the top of the zip: not a Day One export');
  return name.slice(0, -5);
}
export interface Archive {
  journal: string;
  entries: Item[];
  names: Record<string, number>;
  read: (name: string, maxBytes?: number) => Promise<Buffer>;
  close: () => void;
}
function crcStep(crc: number, data: Buffer): number {
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc;
}
export async function read(
  path: string,
  limits: { maxJson?: number; maxFile?: number; maxMembers?: number } = {}
): Promise<Archive> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(path, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: true
    });
  } catch {
    throw new ExportError('Invalid Day One zip');
  }
  try {
    const members = new Map<string, yauzl.Entry>();
    for await (const entry of zip.eachEntry()) {
      if (members.size >= (limits.maxMembers ?? MAX_MEMBERS)) throw new ExportError('Too many zip members');
      if (members.has(entry.fileName)) throw new ExportError('Duplicate zip member');
      if (entry.isEncrypted() || !entry.canDecodeFileData()) throw new ExportError('Unsupported zip member');
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (mode === 0xa000) throw new ExportError('Symlink zip member refused');
      members.set(entry.fileName, entry);
    }
    const names = Object.fromEntries([...members].map(([name, entry]) => [name, entry.uncompressedSize])),
      journal = journalName(Object.keys(names)),
      jsonName = `${journal}.json`;
    const readMember = async (name: string, maxBytes = limits.maxFile ?? MAX_FILE) => {
      if (name !== jsonName && !FILE_NAME.test(name)) throw new ExportError('Noncanonical export member');
      const entry = members.get(name);
      if (!entry) throw new ExportError('Export member missing');
      if (entry.uncompressedSize > maxBytes) throw new ExportError('Export member exceeds read limit');
      const stream = await zip.openReadStreamPromise(entry),
        chunks: Buffer[] = [];
      let size = 0,
        crc = 0xffffffff;
      try {
        for await (const raw of stream) {
          const chunk = Buffer.from(raw as Uint8Array);
          size += chunk.length;
          crc = crcStep(crc, chunk);
          if (size > maxBytes) throw new ExportError('Export member exceeds read limit');
          chunks.push(chunk);
        }
      } catch {
        stream.destroy();
        throw new ExportError('Invalid export member');
      }
      if (size !== entry.uncompressedSize || (crc ^ 0xffffffff) >>> 0 !== entry.crc32)
        throw new ExportError('Export member integrity mismatch');
      return Buffer.concat(chunks);
    };
    let json: unknown;
    try {
      json = JSON.parse((await readMember(jsonName, limits.maxJson ?? MAX_JSON)).toString('utf8'));
    } catch (error) {
      if (error instanceof ExportError) throw error;
      throw new ExportError('Invalid journal JSON');
    }
    const entries = object(json)?.entries;
    if (!Array.isArray(entries) || entries.some((e) => object(e) === null))
      throw new ExportError('Invalid journal entries');
    return { journal, entries: entries as Item[], names, read: readMember, close: () => zip.close() };
  } catch (error) {
    zip.close();
    if (error instanceof ExportError) throw error;
    throw new ExportError('Invalid Day One zip');
  }
}
