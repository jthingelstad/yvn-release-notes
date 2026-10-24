/** Owner-facing wire DTOs, shared by the HTTP readers. No stored object key
 * is returned: media links are signed only after checking the subscriber prefix. */
import type { Item } from './store-types.ts';
import type { Objects } from './services.ts';
import { segments, type Link } from './links.ts';
import { others, MAX_UPLOAD } from './media.ts';
import { split } from '../domain/tags.ts';
import { writtenAt, placeLabel, mapUrl, type NoteRecord, type PlaceRecord } from '../domain/notes.ts';
import { localDay, addDays, validTimezone } from '../domain/dates.ts';
import { computeVersion } from '../domain/version.ts';
import { dayLine, dayPlace, fahrenheit, placeOf, type Reading } from './weather.ts';
export const pauseStart = (p: Item, today: string): string =>
  String(p.last_sent_date ?? '') >= today ? addDays(today, 1) : today;
export function profileView(p: Item, now: number, inboundDomain: string): Item {
  const today = localDay(now, String(p.tz)),
    v = computeVersion(String(p.birthday), today),
    view: Item = {
      new: false,
      email: p.email,
      birthday: p.birthday,
      tz: p.tz,
      send_time: p.send_time ?? '06:00',
      status: p.status ?? 'active',
      transcribe: Boolean(p.transcribe),
      describe: Boolean(p.describe),
      badges: p.badges !== false,
      // On unless turned off (Jamie, 2026-10-24).
      here: p.here !== false,
      today,
      version: v.toString(),
      pause_starts: pauseStart(p, today)
    };
  for (const k of ['city', 'region', 'country', 'stopped_reason']) if (p[k]) view[k] = p[k];
  if (p.inbox) view.inbox = `${p.inbox}@${inboundDomain}`;
  if (String(p.pause_through ?? '') >= today && p.pause_from)
    view.pause = { from: p.pause_from, through: p.pause_through };
  return view;
}
export type MediaLink = (key: unknown, type: string) => Promise<string | null>;
export function mediaLinks(objects: Objects, uid: string): MediaLink {
  return async (key, type) =>
    typeof key === 'string' && key.startsWith(`media/${uid}/`)
      ? objects.download(key, type, 900, { disposition: 'inline', cache: 'private, max-age=600' })
      : null;
}
export async function noteView(item: Item, tz: string, writingOut = false, link?: MediaLink): Promise<Item> {
  const day = String(item.sk).split('#')[1]!,
    at = writtenAt(item as NoteRecord),
    zone = validTimezone(item.tz) ? String(item.tz) : tz,
    view: Item = {
      id: String(item.sk).split('#').slice(2).join('#'),
      source: item.source ?? 'email',
      text: item.text ?? '',
      at,
      tz: zone,
      author: item.author ?? 'user',
      client: item.client ?? null,
      parts: split(segments(String(item.text ?? ''), item.links as Link[] | undefined))
    };
  if (item.connection) Object.assign(view, { connection: item.connection, on_behalf_of: item.on_behalf_of });
  if (item.tags) view.tags = item.tags;
  if (item.place) {
    const label = placeLabel(item.place as PlaceRecord);
    if (label) view.place = label;
    const url = mapUrl(item.place as PlaceRecord);
    if (url) view.map = url;
  }
  if (item.origin) view.from = (item.origin as Item).app === 'dayone' ? 'Day One' : 'an import';
  if (item.updated_at) view.edited_at = item.updated_at;
  if (item.media) {
    view.media = await Promise.all(
      (item.media as Item[]).map(async (m) => {
        const shown: Item = { n: Number(m.n), kind: m.kind, type: m.type, ...(m.name ? { name: m.name } : {}) };
        if (link) {
          const url = await link(m.key, String(m.type));
          if (url) {
            shown.url = url;
            const thumb = (m.thumb as Item | undefined)?.key;
            if (thumb) {
              const small = await link(thumb, 'image/jpeg');
              if (small) shown.thumb = small;
            }
          }
        }
        if (m.transcript) shown.transcript = m.transcript;
        if (m.description) shown.description = m.description;
        if (writingOut)
          shown.writing =
            m.kind === 'audio' &&
            ['audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/flac'].includes(
              String(m.type)
            ) &&
            !Object.hasOwn(m, 'transcript') &&
            Number(m.size ?? 0) <= MAX_UPLOAD &&
            String(m.key ?? '').startsWith('media/');
        return shown;
      })
    );
  }
  const attachments = others(item as NoteRecord);
  if (attachments) view.attachments = attachments;
  const epoch = Date.parse(at);
  if (Number.isFinite(epoch)) view.late = localDay(Math.floor(epoch / 1000), zone) > day;
  return view;
}
export async function dayView(
  p: Item,
  day: string,
  notes: Item[],
  sky?: Item | null,
  link?: MediaLink,
  own?: Item | null,
  whole: Item[] = notes
): Promise<Item> {
  const view: Item = {
    date: day,
    version: computeVersion(String(p.birthday), day).toString(),
    notes: await Promise.all(notes.map((n) => noteView(n, String(p.tz), Boolean(p.transcribe), link)))
  };
  // A note that came without a place (an email reply, say) shows the day's
  // city, as the weather finds it, or else home, marked as inherited and
  // never mapped (Jamie, 2026-10-24: "inherit the users location for that
  // account or day unless they override it"). Derived here, never stored,
  // so it follows the day; a note's own place, or its "No place", wins.
  // From the whole day, so a search or tag page shows what the day does.
  const shared = dayPlace(own as PlaceRecord | null, whole as NoteRecord[], String(p.tz)),
    around = shared ?? placeOf(p),
    label = around && placeLabel({ city: around.city, region: around.region, country: around.country });
  if (label)
    notes.forEach((n, i) => {
      if (n.place || n.place_cleared) return;
      Object.assign((view.notes as Item[])[i]!, { place: label, place_from: shared ? 'day' : 'home' });
    });
  if (own && placeLabel(own as PlaceRecord)) view.where = placeLabel(own as PlaceRecord);
  if (sky) view.weather = dayLine(sky as Reading, fahrenheit(placeOf(p) ?? (sky as PlaceRecord)));
  return view;
}
