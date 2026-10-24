/** The Map page's base map: Amazon Location's style, tiles, glyphs and
 * sprites, fetched under the web role and served from this origin to a
 * signed-in owner. The browser holds no key and asks no one else, and what
 * it looks at is only ever seen by AWS. */
import {
  GeoMapsClient,
  GetGlyphsCommand,
  GetSpritesCommand,
  GetStyleDescriptorCommand,
  GetTileCommand
} from '@aws-sdk/client-geo-maps';
import type { NoteRecord } from '../domain/notes.ts';
import { placeLabel } from '../domain/notes.ts';
import { split, type TagPart } from '../domain/tags.ts';
import { codePointSlice, pythonTrim } from '../domain/unicode.ts';
import { segments, type Link, type LinkPart } from './links.ts';

export type Scheme = 'Light' | 'Dark';
export const STYLE = 'Standard',
  TILESET = 'vector.basemap';
export interface MapFile {
  body: Uint8Array;
  type: string;
}
export interface Maps {
  style(scheme: Scheme): Promise<MapFile>;
  tile(z: number, x: number, y: number): Promise<MapFile | null>;
  glyphs(fonts: string, range: string): Promise<MapFile | null>;
  sprites(scheme: Scheme, file: string): Promise<MapFile | null>;
}

const missing = (error: unknown) =>
  (error as { name?: string })?.name === 'ResourceNotFoundException' ||
  (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
// Typed here: Amazon Location calls a sprite's JSON binary/octet-stream.
async function file(send: () => Promise<{ Blob?: Uint8Array }>, type: string): Promise<MapFile | null> {
  try {
    const answer = await send();
    return answer.Blob ? { body: answer.Blob, type } : null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
/** Amazon Location, signed as the web role. */
export function geoMaps(client = new GeoMapsClient({})): Maps {
  return {
    async style(scheme) {
      const answer = await client.send(new GetStyleDescriptorCommand({ Style: STYLE, ColorScheme: scheme }));
      return { body: answer.Blob ?? new Uint8Array(), type: 'application/json' };
    },
    tile: (z, x, y) =>
      file(
        () => client.send(new GetTileCommand({ Tileset: TILESET, Z: String(z), X: String(x), Y: String(y) })),
        'application/x-protobuf'
      ),
    glyphs: (fonts, range) =>
      file(
        () => client.send(new GetGlyphsCommand({ FontStack: fonts, FontUnicodeRange: range + '.pbf' })),
        'application/x-protobuf'
      ),
    sprites: (scheme, name) =>
      file(
        () =>
          client.send(new GetSpritesCommand({ FileName: name, Style: STYLE, ColorScheme: scheme, Variant: 'Default' })),
        name.endsWith('.json') ? 'application/json' : 'image/png'
      )
  };
}

/** The style with every Amazon Location address turned into this origin's
 * own, so tiles, glyphs and sprites come back through the routes below. A
 * source of any other kind is dropped, with the layers drawn from it. The
 * map is flat (Jamie, 2026-10-24: "a two-dimensional map"): Amazon's style
 * asks for a globe and a sky, and both go. */
export function ownStyle(raw: Uint8Array | string, scheme: Scheme, origin: string): Record<string, unknown> {
  const style = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as Record<string, unknown>,
    sources = (style.sources ?? {}) as Record<string, Record<string, unknown>>,
    kept: Record<string, Record<string, unknown>> = {};
  for (const [name, source] of Object.entries(sources)) {
    const tiles = Array.isArray(source.tiles) ? (source.tiles as unknown[]) : [];
    if (source.type === 'vector' && tiles.length && tiles.every((t) => String(t).includes(`/v2/tiles/${TILESET}/`)))
      kept[name] = { ...source, tiles: [`${origin}/api/map/tiles/{z}/{x}/{y}`] };
  }
  style.sources = kept;
  style.layers = ((style.layers ?? []) as Record<string, unknown>[]).filter(
    (layer) => !layer.source || Object.hasOwn(kept, String(layer.source))
  );
  if (style.glyphs) style.glyphs = `${origin}/api/map/glyphs/{fontstack}/{range}.pbf`;
  if (style.sprite) style.sprite = `${origin}/api/map/sprites/${scheme}/sprites`;
  style.projection = { type: 'mercator' };
  delete style.sky;
  return style;
}

/** One pin: a note that has a place of its own with coordinates. A note
 * showing its day's or home's city (inherited) has none, and is left out. */
export interface Pin {
  date: string;
  id: string;
  lat: number;
  lon: number;
  place: string;
  exact: boolean;
  /** Its hashtags, every one, as stored with it: the Map's tag filter. */
  tags: string[];
  /** The preview as plain words, and as the web shows it (`parts`, the
   * same links by name and tags as every note: links.segments). */
  text: string;
  parts: Part[];
}
type Part = string | LinkPart | TagPart;
const PREVIEW = 140;
const shown = (part: Part) => (typeof part === 'string' ? part : 'tag' in part ? part.text : part.label);
/** The first PREVIEW characters as read, so a link counts by its name and
 * a long address cannot fill the preview. A link or tag is kept whole or
 * left for the ellipsis. */
function preview(note: NoteRecord): { text: string; parts: Part[] } {
  const words = pythonTrim(String(note.text ?? '').replace(/\s+/g, ' ')),
    all: Part[] = split(segments(words, note.links as Link[] | undefined)),
    size = (part: Part) => Array.from(shown(part)).length;
  if (all.reduce((n, part) => n + size(part), 0) <= PREVIEW) return { text: all.map(shown).join(''), parts: all };
  const parts: Part[] = [];
  let left = PREVIEW - 1;
  for (const part of all) {
    if (size(part) <= left) {
      parts.push(part);
      left -= size(part);
      continue;
    }
    if (typeof part === 'string') parts.push(codePointSlice(part, 0, left));
    parts.push('…');
    break;
  }
  return { text: parts.map(shown).join(''), parts };
}
export function pins(notes: readonly NoteRecord[]): Pin[] {
  const out: Pin[] = [];
  for (const note of notes) {
    const place = note.place;
    if (!place || note.place_cleared) continue;
    const lat = Number(place.lat ?? NaN),
      lon = Number(place.lon ?? NaN);
    if (place.lat == null || place.lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const [, date = '', ...rest] = String(note.sk).split('#');
    out.push({
      date,
      id: rest.join('#'),
      lat,
      lon,
      place: placeLabel(place),
      // A city chosen from the search stands for the city, not a spot in it.
      exact: place.from !== 'chosen',
      tags: Array.isArray(note.tags) ? note.tags.map(String) : [],
      ...preview(note)
    });
  }
  return out;
}
