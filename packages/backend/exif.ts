/** Read a photo's time/GPS from its EXIF TIFF bytes without decoding or
 * changing the original: a JPEG's APP1 segment (bounded), or the Exif item
 * of a HEIC/HEIF (an iPhone's own format), found through its meta box.
 * Malformed or unsupported files give no metadata. */
import { validDay } from '../domain/dates.ts';
import { rounded } from './places.ts';
export const MAX_SCAN = 256 * 1024;
export interface Exif {
  taken_at?: string;
  lat?: number;
  lon?: number;
}
type Entry = { kind: number; count: number; at: number };
function app1(data: Buffer): Buffer | null {
  if (data[0] !== 255 || data[1] !== 216) return null;
  let i = 2;
  const end = Math.min(data.length, MAX_SCAN);
  while (i + 4 <= end) {
    if (data[i] !== 255) return null;
    const marker = data[i + 1];
    if (marker === 255) {
      i++;
      continue;
    }
    if (marker === 217 || marker === 218) return null;
    const length = data.readUInt16BE(i + 2);
    if (length < 2) return null;
    const body = data.subarray(i + 4, i + 2 + length);
    if (marker === 225 && body.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) return body.subarray(6);
    i += 2 + length;
  }
  return null;
}
// HEIF (ISO BMFF): the boxes in [start, end), as [type, body start, end].
function boxes(data: Buffer, start: number, end: number): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  let i = start;
  while (i + 8 <= end) {
    let size = data.readUInt32BE(i),
      head = 8;
    if (size === 1) {
      if (i + 16 > end) throw new RangeError('Box');
      size = Number(data.readBigUInt64BE(i + 8));
      head = 16;
    } else if (size === 0) size = end - i;
    if (size < head || i + size > end) throw new RangeError('Box');
    out.push([data.toString('latin1', i + 4, i + 8), i + head, i + size]);
    i += size;
  }
  return out;
}
function sized(data: Buffer, at: number, bytes: number): number {
  if (bytes === 0) return 0;
  if (bytes === 4) return data.readUInt32BE(at);
  if (bytes === 8) return Number(data.readBigUInt64BE(at));
  throw new RangeError('Field size');
}
/** The Exif item's TIFF bytes: its id from iinf, its bytes from iloc (in
 * the file, one extent), past the item's own offset to the TIFF header. */
function heif(data: Buffer): Buffer | null {
  if (data.length < 8 || data.toString('latin1', 4, 8) !== 'ftyp') return null;
  const top = boxes(data, 0, data.length);
  const meta = top.find(([type]) => type === 'meta');
  if (!meta) return null;
  const inner = boxes(data, meta[1] + 4, meta[2]),
    iinf = inner.find(([type]) => type === 'iinf'),
    iloc = inner.find(([type]) => type === 'iloc');
  if (!iinf || !iloc) return null;
  let id: number | null = null;
  const v = data[iinf[1]]!;
  for (const [type, at, end] of boxes(data, iinf[1] + (v === 0 ? 6 : 8), iinf[2])) {
    const version = data[at]!;
    if (type !== 'infe' || version < 2) continue;
    const item = version === 2 ? data.readUInt16BE(at + 4) : data.readUInt32BE(at + 4),
      kind = at + (version === 2 ? 8 : 10);
    if (kind + 4 <= end && data.toString('latin1', kind, kind + 4) === 'Exif') {
      id = item;
      break;
    }
  }
  if (id === null) return null;
  let i = iloc[1];
  const version = data[i]!,
    sizes = data.readUInt16BE(i + 4),
    offsetSize = sizes >> 12,
    lengthSize = (sizes >> 8) & 15,
    baseSize = (sizes >> 4) & 15,
    indexSize = version ? sizes & 15 : 0,
    count = version < 2 ? data.readUInt16BE(i + 6) : data.readUInt32BE(i + 6);
  i += version < 2 ? 8 : 10;
  for (let n = 0; n < count; n++) {
    const item = version < 2 ? data.readUInt16BE(i) : data.readUInt32BE(i);
    i += version < 2 ? 2 : 4;
    const method = version ? data.readUInt16BE(i) & 15 : 0;
    if (version) i += 2;
    i += 2;
    const base = sized(data, i, baseSize);
    i += baseSize;
    const extents = data.readUInt16BE(i);
    i += 2;
    if (item !== id) {
      i += extents * (indexSize + offsetSize + lengthSize);
      continue;
    }
    if (method !== 0 || extents !== 1) return null;
    i += indexSize;
    const start = base + sized(data, i, offsetSize),
      length = sized(data, i + offsetSize, lengthSize),
      end = length ? start + length : data.length;
    if (end > data.length || start + 4 > end) throw new RangeError('Exif item');
    const tiff = start + 4 + data.readUInt32BE(start);
    if (tiff >= end) throw new RangeError('Exif item');
    return data.subarray(tiff, end);
  }
  return null;
}
class Tiff {
  little: boolean;
  constructor(readonly bytes: Buffer) {
    const order = bytes.toString('ascii', 0, 2);
    if (!['II', 'MM'].includes(order)) throw new RangeError('Byte order');
    this.little = order === 'II';
    if (this.u16(2) !== 42) throw new RangeError('TIFF magic');
  }
  u16(at: number) {
    return this.little ? this.bytes.readUInt16LE(at) : this.bytes.readUInt16BE(at);
  }
  u32(at: number) {
    return this.little ? this.bytes.readUInt32LE(at) : this.bytes.readUInt32BE(at);
  }
  ifd(at: number): Map<number, Entry> {
    const out = new Map<number, Entry>();
    if (at < 8 || at > this.bytes.length - 2) return out;
    const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    for (let k = 0; k < Math.min(this.u16(at), 512); k++) {
      const e = at + 2 + 12 * k;
      if (e + 12 > this.bytes.length) break;
      const tag = this.u16(e),
        kind = this.u16(e + 2),
        count = this.u32(e + 4),
        size = (sizes[kind] ?? 0) * count;
      const where = size <= 4 ? e + 8 : this.u32(e + 8);
      if (size && where + size <= this.bytes.length) out.set(tag, { kind, count, at: where });
    }
    return out;
  }
  text(entry?: Entry): string {
    if (!entry || entry.kind !== 2) return '';
    return this.bytes
      .subarray(entry.at, entry.at + entry.count)
      .toString('latin1')
      .split('\0')[0]!
      .trim();
  }
  rationals(entry?: Entry): number[] {
    if (!entry || entry.kind !== 5 || entry.count !== 3) return [];
    const out: number[] = [];
    for (let k = 0; k < entry.count; k++) {
      const denominator = this.u32(entry.at + 8 * k + 4);
      if (!denominator) return [];
      out.push(this.u32(entry.at + 8 * k) / denominator);
    }
    return out;
  }
}
function taken(t: Tiff, ifd: Map<number, Entry>): string | null {
  const match = /^([+-]?[0-9]+):([+-]?[0-9]+):([+-]?[0-9]+) ([+-]?[0-9]+):([+-]?[0-9]+):([+-]?[0-9]+)$/.exec(
    t.text(ifd.get(0x9003))
  );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((v) => Number(v));
  const padded = (value: number | undefined, width = 2) => String(value).padStart(width, '0');
  const date = `${padded(year, 4)}-${padded(month)}-${padded(day)}`;
  if (
    !Number.isInteger(year) ||
    year! <= 1900 ||
    year! >= 2200 ||
    !validDay(date) ||
    hour! < 0 ||
    hour! > 23 ||
    minute! < 0 ||
    minute! > 59 ||
    second! < 0 ||
    second! > 60
  )
    return null;
  let out = `${date}T${padded(hour)}:${padded(minute)}:${padded(second)}`;
  const offset = t.text(ifd.get(0x9011));
  if (/^[+-][0-9]{2}:[0-9]{2}$/.test(offset)) out += offset;
  return out;
}
function coordinate(
  t: Tiff,
  gps: Map<number, Entry>,
  value: number,
  ref: number,
  positive: string,
  negative: string,
  limit: number
): number | null {
  const parts = t.rationals(gps.get(value)),
    side = t.text(gps.get(ref)).toUpperCase();
  if (parts.length !== 3 || ![positive, negative].includes(side)) return null;
  const degrees = parts[0]! + parts[1]! / 60 + parts[2]! / 3600;
  return degrees >= 0 && degrees <= limit ? rounded(side === negative ? -degrees : degrees, 6) : null;
}
export function read(data: Buffer): Exif {
  try {
    const segment = app1(data) ?? heif(data);
    if (!segment) return {};
    const t = new Tiff(segment),
      ifd = t.ifd(t.u32(4)),
      out: Exif = {};
    const exif = ifd.get(0x8769),
      gps = ifd.get(0x8825);
    if (exif?.kind === 4) {
      const time = taken(t, t.ifd(t.u32(exif.at)));
      if (time) out.taken_at = time;
    }
    if (gps?.kind === 4) {
      const values = t.ifd(t.u32(gps.at)),
        lat = coordinate(t, values, 2, 1, 'N', 'S', 90),
        lon = coordinate(t, values, 4, 3, 'E', 'W', 180);
      if (lat !== null && lon !== null && (lat !== 0 || lon !== 0)) {
        out.lat = lat;
        out.lon = lon;
      }
    }
    return out;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return {};
  }
}
