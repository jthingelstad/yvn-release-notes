/** Read JPEG time/GPS from bounded APP1/TIFF bytes without decoding or
 * changing the original. Malformed or unsupported files give no metadata. */
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
    const segment = app1(data);
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
