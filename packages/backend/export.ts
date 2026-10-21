/** Owner exports retain note provenance, files, places and weather while
 * leaving out reply addresses, raw keys, session tokens and SDK bookkeeping.
 * Markdown groups days under their birthday-to-birthday release. Badges are
 * worked out at export time from the same rows, oldest first. The JSON holds
 * the activity log, oldest first, as its owner sees it on the web. */
import { localDay, parseDay, validDay, validTimezone } from '../domain/dates.ts';
import { combine, placeLabel, writtenAt, type NoteRecord, type PlaceRecord } from '../domain/notes.ts';
import { computeVersion, releaseName } from '../domain/version.ts';
import { markdown as namedLinks, type Link } from './links.ts';
import * as weather from './weather.ts';
import { extension } from './media.ts';
import { object } from './places.ts';
import type { Item } from './store.ts';
import { upcomingEntry, type UpcomingEntry } from '../domain/upcoming.ts';
import { badgesOf } from './badges.ts';
import { ACTIVITY, LEGACY_MAIL, activityView, legacyMail } from '../domain/activity.ts';
export const PROFILE_FIELDS = [
  'email',
  'birthday',
  'tz',
  'send_time',
  'status',
  'created_at',
  'city',
  'region',
  'country',
  'lat',
  'lon'
];
export interface ExportFile extends Item {
  path: string;
  kind: string;
  type: string;
  key: string;
  transcript?: string;
  description?: string;
}
export type FilePaths = Record<string, ExportFile[]>;
export interface ExportNote extends Item {
  id: string;
  date: string;
  version: string;
  text: string;
  written_at: string | null;
}
export interface ExportBadge {
  id: string;
  level?: string;
  name: string;
  line: string;
  /** The version it is stamped with, the day that version is, and the day
   * it came true (later, for a special day written about afterwards). */
  version: string;
  day: string;
  earned: string;
}
export interface ExportData {
  exported_at: string;
  profile: Item;
  notes: ExportNote[];
  days_sent: Item[];
  pauses: Item[];
  weather: Item[];
  places: Item[];
  upcoming?: UpcomingEntry[];
  badges?: ExportBadge[];
  activity?: Item[];
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortBy = (rows: Item[], key: string) => rows.sort((a, b) => cmp(String(a[key]), String(b[key])));
export function filePaths(items: readonly Item[], owner?: string): FilePaths {
  const notes = items
    .filter((i) => String(i.sk).startsWith('NOTE#') && Array.isArray(i.media) && i.media.length)
    .sort(
      (a, b) =>
        cmp(String(a.sk).split('#')[1]!, String(b.sk).split('#')[1]!) ||
        cmp(writtenAt(a as NoteRecord), writtenAt(b as NoteRecord)) ||
        cmp(String(a.sk), String(b.sk))
    );
  const out: FilePaths = {},
    count: Record<string, number> = {};
  for (const item of notes) {
    const [, day, id] = String(item.sk).split('#');
    if (!day || !id || !validDay(day)) continue;
    for (const raw of item.media as unknown[]) {
      const m = object(raw);
      if (!m || typeof m.key !== 'string' || typeof m.type !== 'string' || typeof m.kind !== 'string') continue;
      if (owner && !m.key.startsWith(`media/${owner}/`)) continue;
      count[day] = (count[day] ?? 0) + 1;
      let ext = m.key.split('.').at(-1) ?? '';
      if (!/^[a-zA-Z0-9]{1,10}$/.test(ext)) ext = extension(m.type);
      const entry: ExportFile = { path: `files/${day}-${count[day]}.${ext}`, kind: m.kind, type: m.type, key: m.key };
      for (const field of ['transcript', 'description'] as const)
        if (typeof m[field] === 'string' && m[field]) entry[field] = m[field];
      (out[id] ??= []).push(entry);
    }
  }
  return out;
}
export function build(items: readonly Item[], exportedAt: string, files?: FilePaths): ExportData {
  const hasFiles = files !== undefined && Object.keys(files).length > 0;
  let profile: Item = {};
  const days: Item[] = [],
    notes: ExportNote[] = [],
    pauses: Item[] = [],
    skies: Item[] = [],
    spots: Item[] = [],
    upcoming: UpcomingEntry[] = [],
    activity: Item[] = [];
  const exported = Date.parse(exportedAt) / 1000;
  for (const item of items) {
    const sk = String(item.sk);
    if (sk === 'PROFILE')
      profile = Object.fromEntries(PROFILE_FIELDS.filter((k) => k in item).map((k) => [k, item[k]]));
    else if (sk.startsWith('DAY#'))
      days.push({ date: sk.slice(4), version: item.version ?? null, sent_at: item.sent_at ?? null });
    else if (sk.startsWith('NOTE#')) {
      const [, day, id] = sk.split('#'),
        media = Array.isArray(item.media) ? (item.media as Item[]) : [];
      if (!day || !id) continue;
      const note: ExportNote = {
        id,
        date: day,
        version: String(item.version || ''),
        source: item.source ?? 'email',
        author: item.author ?? 'user',
        client: item.client ?? null,
        connection: item.connection ?? null,
        on_behalf_of: item.on_behalf_of ?? null,
        text: String(item.text ?? ''),
        written_at: writtenAt(item as NoteRecord) || null,
        tz: item.tz ?? null,
        place: item.place ?? null,
        tags: Array.isArray(item.tags) ? item.tags : item.tags instanceof Set ? [...item.tags] : [],
        origin: item.origin ?? null,
        updated_at: item.updated_at ?? null,
        subject: item.subject ?? null,
        attachments: item.attachments ?? [],
        links: item.links ?? [],
        files: (files?.[id] ?? []).map((f) =>
          Object.fromEntries(
            ['path', 'kind', 'type', 'transcript', 'description'].filter((k) => f[k]).map((k) => [k, f[k]])
          )
        ),
        transcripts: hasFiles ? [] : media.filter((m) => m.transcript).map((m) => String(m.transcript)),
        descriptions: hasFiles ? [] : media.filter((m) => m.description).map((m) => String(m.description))
      };
      notes.push(note);
    } else if (sk.startsWith('PAUSE#')) pauses.push({ from: sk.slice(6), through: item.through ?? null });
    else if (sk.startsWith('UPCOMING#')) upcoming.push(upcomingEntry(item));
    else if (sk.startsWith(ACTIVITY)) activity.push(item);
    else if (sk.startsWith(LEGACY_MAIL) && Number(item.expires_at ?? 0) > exported) activity.push(legacyMail(item));
    else if (sk.startsWith('WEATHER#')) skies.push({ date: sk.slice(8), ...weather.plain(item as weather.Reading) });
    else if (sk.startsWith('PLACE#'))
      spots.push({
        date: sk.slice(6),
        ...Object.fromEntries(Object.entries(item).filter(([k]) => !['pk', 'sk'].includes(k)))
      });
  }
  if (typeof profile.birthday === 'string')
    for (const n of notes) n.version ||= computeVersion(profile.birthday, n.date).toString();
  const epoch = Date.parse(exportedAt),
    badges: ExportBadge[] =
      validDay(profile.birthday) && validTimezone(profile.tz) && Number.isFinite(epoch) && notes.length
        ? badgesOf(items, profile, localDay(Math.floor(epoch / 1000), String(profile.tz)))
            .earned.reverse()
            .map((e) => ({
              id: e.id,
              ...(e.level ? { level: e.level } : {}),
              name: e.name,
              line: e.line,
              version: e.version,
              day: e.day,
              earned: e.earned
            }))
        : [];
  notes.sort((a, b) => cmp(a.date, b.date) || cmp(a.written_at || '', b.written_at || '') || cmp(a.id, b.id));
  for (const n of notes)
    for (const key of [
      'updated_at',
      'subject',
      'links',
      'files',
      'transcripts',
      'descriptions',
      'tz',
      'place',
      'tags',
      'origin'
    ]) {
      const value = n[key];
      if (!value || (Array.isArray(value) && !value.length) || (object(value) && !Object.keys(value as Item).length))
        delete n[key];
    }
  return {
    exported_at: exportedAt,
    profile,
    notes,
    days_sent: sortBy(days, 'date'),
    pauses: sortBy(pauses, 'from'),
    weather: sortBy(skies, 'date'),
    places: sortBy(spots, 'date'),
    ...(upcoming.length ? { upcoming: upcoming.sort((a, b) => cmp(a.id, b.id)) } : {}),
    ...(badges.length ? { badges } : {}),
    ...(activity.length
      ? {
          activity: [...new Map(activity.map((r) => [String(r.sk), r])).values()]
            .sort((a, b) => cmp(String(a.sk), String(b.sk)))
            .map(activityView)
        }
      : {})
  };
}
export function longDate(day: string): string {
  const { year, month, day: d } = parseDay(day),
    date = new Date(0);
  date.setUTCFullYear(year, month - 1, d);
  date.setUTCHours(12, 0, 0, 0);
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(date),
    name = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(date);
  return `${weekday}, ${name} ${d}, ${year}`;
}
function escapeText(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/([\\`*_{}[\]()#+.!|>~-])/g, '\\$1');
}
export function markdown(data: ExportData): string {
  const { profile } = data,
    lines = ['# Release Notes', ''];
  lines.push(`Exported ${data.exported_at.slice(0, 10)}${profile.email ? ` for ${profile.email}` : ''}.`);
  const born = typeof profile.birthday === 'string' ? profile.birthday : null;
  if (born) lines.push('', `Born ${longDate(born)}: that day was 0.0.0.`);
  if (data.upcoming?.length) {
    lines.push('', '## Upcoming', '', 'Saved plans and personal dates.');
    for (const entry of data.upcoming) {
      lines.push(
        '',
        `### ${escapeText(entry.title)}`,
        '',
        `${entry.kind}: ${entry.date}${entry.year === null ? '' : ` (original year ${entry.year})`}${entry.end_date ? ` through ${entry.end_date}` : ''}.`,
        ...(entry.tag ? [`Tag: ${escapeText('#' + entry.tag)}.`] : []),
        ...(entry.place
          ? [`At ${escapeText(entry.place.name)}${entry.place.region ? ', ' + escapeText(entry.place.region) : ''}.`]
          : []),
        entry.email
          ? `Daily email reminders: ${entry.reminders.join(', ')} days before (0 means on the day).`
          : 'Kept on the web only.'
      );
    }
  }
  if (data.badges?.length) {
    lines.push(
      '',
      '## Badges',
      '',
      `${data.badges.length === 1 ? '1 badge' : `${data.badges.length} badges`}, each with the version it was earned on.`,
      ''
    );
    for (const b of data.badges) lines.push(`- ${b.version}: ${b.name}. ${b.line}`);
  }
  const skies = new Map(data.weather.map((w) => [String(w.date), w])),
    spots = new Map(data.places.map((p) => [String(p.date), p])),
    byDay = new Map<string, ExportNote[]>();
  for (const day of spots.keys()) byDay.set(day, []);
  for (const n of data.notes) {
    const notes = byDay.get(n.date) ?? [];
    notes.push(n);
    byDay.set(n.date, notes);
  }
  if ([...byDay.keys()].some((day) => skies.has(day)))
    lines.push('', `${weather.CREDIT} (${weather.CREDIT_URL}), CC BY 4.0.`);
  if (!byDay.size) lines.push('', 'No notes yet.');
  let release: string | null = null;
  const fahrenheit = weather.fahrenheit(profile as PlaceRecord);
  for (const [day, notes] of [...byDay].sort(([a], [b]) => cmp(a, b))) {
    const text = combine(
      notes.map((n) => ({
        ...n,
        written_at: n.written_at ?? undefined,
        author: typeof n.author === 'string' ? n.author : undefined,
        client: typeof n.client === 'string' ? n.client : undefined,
        text: namedLinks(n.text, n.links as Link[] | undefined)
      })),
      { label: escapeText }
    );
    const version = notes[0]?.version ?? (born ? computeVersion(born, day).toString() : ''),
      named = born ? releaseName(computeVersion(born, day).age) : version.split('.').slice(0, 2).join('.');
    if (named !== release) {
      release = named;
      lines.push('', `## ${release}`);
    }
    lines.push('', `### ${version} · ${longDate(day)}`);
    const sky = skies.get(day);
    if (sky) lines.push('', weather.dayLine(sky as weather.Reading, fahrenheit) + '.');
    const own = spots.get(day),
      where = [
        ...new Set(
          [...(own ? [own] : []), ...notes.map((n) => object(n.place)).filter((p) => p !== null)]
            .map((p) => placeLabel(p as PlaceRecord))
            .filter(Boolean)
        )
      ];
    if (where.length) lines.push('', 'At ' + where.join('; ') + '.');
    const shown = notes.flatMap((n) => (Array.isArray(n.files) ? (n.files as Item[]) : []));
    if (notes.length && (text || !shown.length))
      lines.push('', text || '(Attachments only. They are in the original email.)');
    for (const f of shown) {
      const label = f.kind === 'image' ? 'Photo' : f.kind === 'audio' ? 'Recording' : 'File';
      const alt = f.description
        ? String(f.description).replace(/\[/g, '(').replace(/\]/g, ')')
        : `${label}, ${version}`;
      lines.push('', `${f.kind === 'image' ? '!' : ''}[${alt}](${f.path})`);
      if (f.transcript) lines.push('', '> ' + f.transcript);
    }
    for (const said of notes.flatMap((n) => (Array.isArray(n.transcripts) ? n.transcripts : [])))
      lines.push('', '> ' + said);
  }
  return lines.join('\n') + '\n';
}
