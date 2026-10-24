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
import { codePointSlice, pythonTrim } from '../domain/unicode.ts';

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
 * source of any other kind is dropped, with the layers drawn from it. */
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
  text: string;
}
const PREVIEW = 140;
export function pins(notes: readonly NoteRecord[]): Pin[] {
  const out: Pin[] = [];
  for (const note of notes) {
    const place = note.place;
    if (!place || note.place_cleared) continue;
    const lat = Number(place.lat ?? NaN),
      lon = Number(place.lon ?? NaN);
    if (place.lat == null || place.lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const [, date = '', ...rest] = String(note.sk).split('#'),
      text = pythonTrim(String(note.text ?? '').replace(/\s+/g, ' '));
    out.push({
      date,
      id: rest.join('#'),
      lat,
      lon,
      place: placeLabel(place),
      // A city chosen from the search stands for the city, not a spot in it.
      exact: place.from !== 'chosen',
      text: text.length > PREVIEW ? codePointSlice(text, 0, PREVIEW - 1) + '…' : text
    });
  }
  return out;
}
