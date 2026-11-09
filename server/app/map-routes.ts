/** The Map page: the owner's placed notes, and the base map it is drawn on,
 * passed through from Amazon Location (packages/backend/maps.ts). */
import { SessionService, reject } from '../../packages/backend/sessions.ts';
import { TILES_A_DAY, ownStyle, pins, type MapFile, type Scheme } from '../../packages/backend/maps.ts';
import { writtenAt, type NoteRecord } from '../../packages/domain/notes.ts';
import { searchedText } from '../../packages/domain/search.ts';
import { body, json, searchFrom } from './requests.ts';

// A day: the map changes rarely, and the browser alone keeps it. The
// owner's notes are never kept (app.ts), only these.
const KEEP = 'private, max-age=86400';
export const BASE_MAP = new Set([
  '/api/map/style/{scheme}',
  '/api/map/tiles/{z}/{x}/{y}',
  '/api/map/glyphs/{fonts}/{range}',
  '/api/map/sprites/{scheme}/{sprite}'
]);
const served = (found: MapFile | null) =>
  found
    ? new Response(Buffer.from(found.body), { headers: { 'content-type': found.type, 'cache-control': KEEP } })
    : json({ error: 'not-found' }, 404);

export async function mapRoutes(service: SessionService, pattern: string, args: string[]): Promise<Response | null> {
  if (!pattern.startsWith('/api/map/')) return null;
  const { uid, profile } = await service.account(),
    ctx = service.context,
    born = String(profile.birthday);
  // Each pin says when its note was written, as /v1's do (1.19.0): ids are
  // random, so a day's pins come in no order of their own, and the Map's
  // Trails join the notes in the order they were written.
  if (pattern === '/api/map/notes') {
    const notes = (await ctx.store.allNotes(uid)) as NoteRecord[],
      written = new Map(notes.map((n) => [String(n.sk), writtenAt(n) || null])),
      found = pins(notes, born).map((pin) => ({
        ...pin,
        written_at: written.get(`NOTE#${pin.date}#${pin.id}`) ?? null
      }));
    return json({ pins: found, notes: notes.length });
  }
  // The Map's search: which pins have every word, as the Search page finds
  // them (transcripts, descriptions and link names too). The words come in
  // the body and the answer names notes by day and id alone.
  if (pattern === '/api/map/search') {
    const terms = searchFrom(await body(service.request)),
      notes = (await ctx.store.allNotes(uid)) as NoteRecord[],
      found = pins(
        notes.filter((n) => terms.every((t) => searchedText(n).includes(t))),
        born
      );
    return json({ terms, found: found.map(({ date, id }) => ({ date, id })) });
  }
  const maps = service.maps();
  if (pattern === '/api/map/style/{scheme}') {
    const scheme = args[0] as Scheme,
      style = ownStyle((await maps.style(scheme)).body, scheme, ctx.origin);
    return new Response(JSON.stringify(style), {
      headers: { 'content-type': 'application/json', 'cache-control': KEEP }
    });
  }
  if (pattern === '/api/map/tiles/{z}/{x}/{y}') {
    const [z, x, y] = args.map(Number) as [number, number, number];
    if (z > 22 || x >= 2 ** z || y >= 2 ** z) reject(404, 'not-found');
    if ((await ctx.store.count(`tiles:${uid}`, Math.floor(ctx.now / 86400), 86400)) > TILES_A_DAY)
      reject(429, 'map-limit');
    return served(await maps.tile(z, x, y));
  }
  if (pattern === '/api/map/glyphs/{fonts}/{range}') {
    const fonts = decodeURIComponent(args[0]!),
      [from, to] = args[1]!.split('-').map(Number) as [number, number];
    if (from % 256 || to !== from + 255 || to > 65535) reject(404, 'not-found');
    return served(await maps.glyphs(fonts, args[1]!));
  }
  if (pattern === '/api/map/sprites/{scheme}/{sprite}') return served(await maps.sprites(args[0] as Scheme, args[1]!));
  return null;
}
