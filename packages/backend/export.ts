/** Owner exports retain note provenance, files, places and weather while
 * leaving out reply addresses, raw keys, session tokens and SDK bookkeeping.
 * Markdown groups days under their birthday-to-birthday release. Badges are
 * worked out at export time from the same rows, oldest first. The JSON holds
 * the activity log, oldest first, as its owner sees it on the web. The zip
 * carries the profile photo (profile-photo.ts) as profile-photo.jpg, named in
 * the JSON's profile as `photo` and in the Markdown under the title. */
import { localDay, parseDay, validDay, validTimezone } from '../domain/dates.ts';
import { combine, placeLabel, writtenAt, type NoteRecord, type PlaceRecord } from '../domain/notes.ts';
import { computeVersion, releaseName } from '../domain/version.ts';
import { momentParts, storedMoment, usesMiles, type Moment } from '../domain/moments.ts';
import { markdown as namedLinks, type Link } from './links.ts';
import * as weather from './weather.ts';
import { extension } from './media.ts';
import { object } from './places.ts';
import type { Item } from './store.ts';
import { upcomingEntry, type UpcomingEntry } from '../domain/upcoming.ts';
import { badgesOf } from './badges.ts';
import { ACTIVITY, activityView } from '../domain/activity.ts';
import { feedbackItem, feedbackView, FEEDBACK_KIND_NAMES } from '../domain/feedback.ts';
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
  /** Feedback to Jamie and the answers (domain/feedback.ts); screenshots by
   * their place in the zip, when it has them. */
  feedback?: Item[];
}
/** The key filePaths files a feedback item's screenshots under. */
export const feedbackFiles = (id: string) => `feedback:${id}`;
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
  // Feedback screenshots, named for the day the item was filed.
  for (const item of items.filter((i) => String(i.sk).startsWith('FEEDBACK#'))) {
    const f = feedbackItem(item),
      day = f.filed_at.slice(0, 10);
    if (!validDay(day) || !/^[0-9a-f]{16}$/.test(f.id)) continue;
    for (const shot of f.screenshots) {
      if (typeof shot.key !== 'string' || (owner && !shot.key.startsWith(`media/${owner}/`))) continue;
      (out[feedbackFiles(f.id)] ??= []).push({
        path: `files/${day}-feedback-${f.id}-${shot.n}.${extension(shot.type)}`,
        kind: 'image',
        type: shot.type,
        key: shot.key
      });
    }
  }
  return out;
}
/** The profile photo, for the zip: only the owner's own object. */
export function photoFile(items: readonly Item[], owner: string): ExportFile | null {
  const p = items.find((i) => i.sk === 'PROFILE'),
    photo = object(p?.photo);
  if (!photo || typeof photo.key !== 'string' || !photo.key.startsWith(`media/${owner}/profile/`)) return null;
  return { path: 'profile-photo.jpg', kind: 'image', type: 'image/jpeg', key: photo.key, set_at: photo.at ?? null };
}
export function build(
  items: readonly Item[],
  exportedAt: string,
  files?: FilePaths,
  photo?: ExportFile | null
): ExportData {
  const hasFiles = files !== undefined && Object.keys(files).length > 0;
  let profile: Item = {},
    stored: Item = {};
  const days: Item[] = [],
    notes: ExportNote[] = [],
    pauses: Item[] = [],
    skies: Item[] = [],
    spots: Item[] = [],
    upcoming: UpcomingEntry[] = [],
    activity: Item[] = [],
    feedback: Item[] = [];
  for (const item of items) {
    const sk = String(item.sk);
    if (sk === 'PROFILE') {
      stored = item;
      profile = Object.fromEntries(PROFILE_FIELDS.filter((k) => k in item).map((k) => [k, item[k]]));
    } else if (sk.startsWith('DAY#'))
      days.push({ date: sk.slice(4), version: item.version ?? null, sent_at: item.sent_at ?? null });
    else if (sk.startsWith('NOTE#')) {
      const [, day, id] = sk.split('#'),
        media = Array.isArray(item.media) ? (item.media as Item[]) : [];
      if (!day || !id) continue;
      const moment = storedMoment(item.moment);
      const note: ExportNote = {
        id,
        date: day,
        version: String(item.version || ''),
        source: item.source ?? 'email',
        author: item.author ?? 'user',
        client: item.client ?? null,
        connection: item.connection ?? null,
        // A token's name at the time it wrote the note: "via <name>".
        ...(item.source === 'api' && item.token ? { token: String(item.token) } : {}),
        on_behalf_of: item.on_behalf_of ?? null,
        text: String(item.text ?? ''),
        written_at: writtenAt(item as NoteRecord) || null,
        tz: item.tz ?? null,
        place: item.place ?? null,
        // As kept, only on a note that has one (docs/MOMENTS.md).
        ...(moment ? { moment } : {}),
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
    else if (sk.startsWith('FEEDBACK#')) {
      const f = feedbackItem(item),
        view = feedbackView(f),
        paths = files?.[feedbackFiles(f.id)] ?? [];
      feedback.push(
        paths.length
          ? {
              ...view,
              screenshots: (view.screenshots as Item[]).map((s, i) => ({
                ...s,
                ...(paths[i] ? { path: paths[i].path } : {})
              }))
            }
          : view
      );
    } else if (sk.startsWith('WEATHER#')) skies.push({ date: sk.slice(8), ...weather.plain(item as weather.Reading) });
    else if (sk.startsWith('PLACE#'))
      spots.push({
        date: sk.slice(6),
        ...Object.fromEntries(Object.entries(item).filter(([k]) => !['pk', 'sk'].includes(k)))
      });
  }
  if (photo) profile.photo = { path: photo.path, set_at: photo.set_at ?? null };
  if (typeof profile.birthday === 'string')
    for (const n of notes) n.version ||= computeVersion(profile.birthday, n.date).toString();
  const epoch = Date.parse(exportedAt),
    badges: ExportBadge[] =
      // The stored profile, for its giving years and photo time: what the page
      // shows, notes or none.
      validDay(profile.birthday) && validTimezone(profile.tz) && Number.isFinite(epoch)
        ? badgesOf(items, stored, localDay(Math.floor(epoch / 1000), String(profile.tz)))
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
    ...(feedback.length ? { feedback: feedback.sort((a, b) => cmp(String(a.filed_at), String(b.filed_at))) } : {}),
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
  const photo = object(profile.photo);
  if (photo && typeof photo.path === 'string') lines.push('', `![Profile photo](${photo.path})`);
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
  if (data.feedback?.length) {
    lines.push('', '## Feedback', '', 'What you told Jamie, and the answers.');
    for (const f of data.feedback) {
      const shots = (f.screenshots as Item[]) ?? [];
      lines.push(
        '',
        `### ${FEEDBACK_KIND_NAMES[f.kind as keyof typeof FEEDBACK_KIND_NAMES] ?? 'Feedback'}, ${longDate(String(f.filed_at).slice(0, 10))}`,
        '',
        escapeText(String(f.text)),
        ...(f.follows ? ['', `Follows ${f.follows}.`] : []),
        ...shots.map((s) => (s.path ? `\n![Screenshot ${s.n}](${s.path})` : `\nScreenshot ${s.n}.`))
      );
      for (const a of (f.answers as Item[]) ?? [])
        lines.push(
          '',
          `Jamie, ${longDate(String(a.at).slice(0, 10))}:`,
          '',
          '> ' + escapeText(String(a.text)).replace(/\n/g, '\n> ')
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
  const fahrenheit = weather.fahrenheit(profile as PlaceRecord),
    miles = usesMiles(typeof profile.country === 'string' ? profile.country : null);
  for (const [day, notes] of [...byDay].sort(([a], [b]) => cmp(a, b))) {
    const text = combine(
      notes.map((n) => ({
        ...n,
        written_at: n.written_at ?? undefined,
        author: typeof n.author === 'string' ? n.author : undefined,
        client: typeof n.client === 'string' ? n.client : undefined,
        text: namedLinks(n.text, n.links as Link[] | undefined)
      })),
      { label: escapeText, via: true }
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
    for (const n of notes)
      if (n.moment)
        lines.push(
          '',
          'Moment: ' +
            momentParts(n.moment as Moment, miles)
              .map((p) => escapeText(p.text))
              .join('; ')
        );
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
