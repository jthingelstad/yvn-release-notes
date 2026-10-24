/** The Map page: the owner's placed notes, and the base map it is drawn on,
 * passed through from Amazon Location (packages/backend/maps.ts). */
import { SessionService, reject } from '../../packages/backend/sessions.ts';
import { ownStyle, pins, type MapFile, type Scheme } from '../../packages/backend/maps.ts';
import type { NoteRecord } from '../../packages/domain/notes.ts';
import { json } from './requests.ts';

// A day: the map changes rarely, and the browser alone keeps it.
const KEEP = 'private, max-age=86400';
const served = (found: MapFile | null) =>
  found
    ? new Response(Buffer.from(found.body), { headers: { 'content-type': found.type, 'cache-control': KEEP } })
    : json({ error: 'not-found' }, 404);

export async function mapRoutes(service: SessionService, pattern: string, args: string[]): Promise<Response | null> {
  if (!pattern.startsWith('/api/map/')) return null;
  const { uid } = await service.account(),
    ctx = service.context;
  if (pattern === '/api/map/notes') {
    const notes = (await ctx.store.allNotes(uid)) as NoteRecord[],
      found = pins(notes);
    return json({ pins: found, notes: notes.length });
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
