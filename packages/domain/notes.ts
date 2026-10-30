/** The same note record is shared by email, web, imports and delegated
 * capture. Rendering keeps provenance; stored keys/coordinates are private. */
import { pythonTrim } from './unicode.ts';
export const MAX_NOTE = 20_000;
export const SOURCES = ['email', 'web', 'import', 'agent', 'api'] as const;
export interface PlaceRecord {
  label?: string;
  venue?: string;
  district?: string;
  city?: string;
  region?: string;
  country?: string;
  lat?: number | string | null;
  lon?: number | string | null;
  from?: string;
  [key: string]: unknown;
}
export interface LinkRecord {
  url: string;
  title?: string;
  site?: string;
  named?: boolean;
  [key: string]: unknown;
}
export interface NoteRecord {
  text?: string;
  written_at?: string;
  received_at?: string;
  author?: string;
  client?: string;
  place?: PlaceRecord;
  links?: LinkRecord[];
  media?: Array<Record<string, unknown>>;
  /** 'rich' when written with rich text (domain/rich.ts); else plain. */
  markup?: string;
  [key: string]: unknown;
}

export function writtenAt(note: NoteRecord): string {
  return note.written_at || note.received_at || '';
}
export function placeLabel(place: PlaceRecord): string {
  const name = place.label || place.venue || place.district || '',
    city = place.city || '';
  if (name && city && name !== city) return `${name}, ${city}`;
  return [name || city, place.region || place.country || ''].filter(Boolean).join(', ');
}

function floatString(raw: number | string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new RangeError('Invalid coordinates');
  if (Object.is(value, -0)) return '-0.0';
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute < 0.0001 || absolute >= 1e16)) {
    return value
      .toExponential()
      .replace(/e([+-])(\d+)$/, (_, sign: string, exp: string) => `e${sign}${exp.padStart(2, '0')}`);
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
function quote(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2C/g, ',');
}
export function mapUrl(place: PlaceRecord): string | null {
  if (place.from === 'home' || place.lat == null || place.lon == null) return null;
  const coordinates = `${floatString(place.lat)},${floatString(place.lon)}`,
    label = placeLabel(place);
  return `https://maps.apple.com/?ll=${quote(coordinates)}${label ? `&q=${quote(label)}` : ''}`;
}

/** Input order is writing order; storage readers sort by writtenAt, not id. */
/** `via` marks a token's note with its name, as the exports do; the morning
 * email leaves it off (docs/API.md, Voice and via). */
export function combine(
  notes: readonly NoteRecord[],
  options: { label?: (name: string) => string; via?: boolean } = {}
): string {
  const parts: string[] = [],
    seen = new Set<string>(),
    label = (name: string) => (options.label ? options.label(name) : name);
  for (const note of notes) {
    let text = pythonTrim(note.text || '');
    if (note.author === 'assistant') {
      const name = label(note.client || 'an agent');
      text = text ? `Added by ${name}:\n${text}` : `Added by ${name}.`;
    } else if (options.via && text && note.source === 'api' && typeof note.token === 'string' && note.token)
      text = `${text}\n(via ${label(note.token)})`;
    if (text && !seen.has(text)) {
      parts.push(text);
      seen.add(text);
    }
  }
  return parts.join('\n\n');
}

export function dayLinks<T extends LinkRecord>(notes: readonly { links?: readonly T[] }[]): T[] {
  const links = new Map<string, T>();
  for (const note of notes) for (const link of note.links || []) if (!links.has(link.url)) links.set(link.url, link);
  return [...links.values()];
}
