/** Owner-only entry validation. All writes go through the request-local
 * guarded Store, proving the live session/account in the same transaction. */
import { randomUUID } from 'node:crypto';
import { reject, ApiError } from './sessions.ts';
import { clean, type City } from './places.ts';
import { validDay, parseDay, formatDay } from '../domain/dates.ts';
import { pythonTrim, codePointLength, fold } from '../domain/unicode.ts';
import { TAG_REFUSALS, fieldTags, isRefused, mergeTags, spelling, storedTags, type Tag } from '../domain/tags.ts';
import {
  annual,
  defaultReminders,
  UPCOMING_KINDS,
  UPCOMING_MAX,
  UPCOMING_TITLE_MAX,
  type UpcomingEntry,
  type UpcomingKind
} from '../domain/upcoming.ts';
import type { Item } from './store-types.ts';

/** A date's fields from a request. `tags` is the whole list (the tags
 * field's rules, docs/TAGS.md); a client written for one tag a date sends
 * `tag` instead, which names the first tag and keeps the rest it had. */
export function upcomingContent(value: Item, today: string, previous: UpcomingEntry | null = null) {
  if (
    Object.keys(value).some(
      (field) =>
        ![
          'kind',
          'title',
          'tags',
          'tag',
          'date',
          'year',
          'end_date',
          'place',
          'email',
          'reminders',
          'revision'
        ].includes(field)
    )
  )
    reject(400, 'upcoming-fields');
  if (!UPCOMING_KINDS.includes(value.kind as UpcomingKind)) reject(400, 'upcoming-kind');
  const kind = value.kind as UpcomingKind;
  if (typeof value.title !== 'string') reject(400, 'upcoming-title');
  const title = pythonTrim(value.title);
  if (!title || codePointLength(title) > UPCOMING_TITLE_MAX || /[\p{Cc}\u2028\u2029]/u.test(title))
    reject(400, 'upcoming-title');
  let tags: Tag[] = [];
  if (value.tags != null) {
    const given = fieldTags(value.tags);
    if (isRefused(given)) reject(400, 'upcoming-tag', { reason: given.refused, at: given.at });
    tags = given;
  } else if (Object.hasOwn(value, 'tag')) {
    let first: Tag | null = null;
    if (value.tag != null && !(typeof value.tag === 'string' && !pythonTrim(value.tag))) {
      const tag = spelling(value.tag);
      if (typeof tag === 'string') reject(400, 'upcoming-tag', { reason: tag });
      first = tag;
    }
    // Such a client shows a key, so the name it had is kept for that key.
    const had = previous ? storedTags(previous) : [];
    tags = mergeTags(first ? [had.find((t) => t.key === first.key) ?? first] : [], had.slice(1));
  }
  const date = value.date;
  if (
    typeof date !== 'string' ||
    !(annual(kind) ? /^\d{2}-\d{2}$/.test(date) && validDay('2000-' + date) : validDay(date))
  )
    reject(400, 'upcoming-date');
  const year = value.year ?? null;
  if (year !== null) {
    if (!annual(kind) || !Number.isInteger(year) || Number(year) < 1 || Number(year) > parseDay(today).year)
      reject(400, 'upcoming-year');
    const [month, day] = date.split('-').map(Number);
    let original: string;
    try {
      original = formatDay(Number(year), month!, day!);
    } catch {
      reject(400, 'upcoming-year');
    }
    if (original > today) reject(400, 'upcoming-year');
  }
  const end_date = value.end_date ?? null;
  if (kind === 'trip' ? !validDay(end_date) || end_date < date : end_date !== null) reject(400, 'upcoming-end');
  const place = value.place == null ? null : clean(value.place);
  if ((value.place != null && !place) || (annual(kind) && place)) reject(400, 'upcoming-place');
  if (kind === 'trip' && !place) reject(400, 'upcoming-place');
  const email = value.email ?? true;
  if (typeof email !== 'boolean') reject(400, 'upcoming-email');
  const reminders = value.reminders ?? defaultReminders(kind);
  if (
    !Array.isArray(reminders) ||
    reminders.length > 6 ||
    !reminders.length ||
    reminders.some((n) => !Number.isInteger(n) || n < 0 || n > 365) ||
    new Set(reminders).size !== reminders.length
  )
    reject(400, 'upcoming-reminders');
  return {
    kind,
    title,
    tags: tags.map((t) => t.key),
    tag_names: tags.map((t) => t.name),
    tag: tags[0]?.key ?? null,
    date,
    year: year as number | null,
    end_date: end_date as string | null,
    place,
    email,
    reminders: (reminders as number[]).toSorted((a, b) => b - a)
  };
}

/** What each refusal of a date asks for, in words an agent or a script's
 * author can act on (workers/capture.ts, workers/api-writes.ts). */
export const UPCOMING_HINTS: Record<string, string> = {
  'upcoming-fields': 'Use only the fields in the schema; an id needs its revision, and a new entry has neither.',
  'upcoming-kind': 'kind is birthday, anniversary, trip or event.',
  'upcoming-title': `Give a title of up to ${UPCOMING_TITLE_MAX} characters on one line.`,
  'upcoming-tag': `tags is a list of up to 20 names, each up to 50 characters on one line, without commas.`,
  'upcoming-date': 'A birthday or anniversary date is MM-DD; a trip or event date is YYYY-MM-DD.',
  'upcoming-year': 'A year goes with a birthday or anniversary and is not after today.',
  'upcoming-end': 'A trip has an end_date on or after its date; other kinds have none.',
  'upcoming-place':
    'A trip needs a destination the city search knows, like "Zürich" or "Paris, Texas"; other kinds have none.',
  'upcoming-email': 'email is true or false.',
  'upcoming-reminders': 'reminders are up to six different days from 0 to 365.',
  'upcoming-limit': `The account can hold ${UPCOMING_MAX} saved dates.`,
  'upcoming-batch': `Send at most ${UPCOMING_MAX} entries per call.`
};

/** A refusal's hint, the tags field's own reason first. */
export function upcomingHint(error: ApiError): string | undefined {
  const reason = error.extra.reason;
  return error.error === 'upcoming-tag' && typeof reason === 'string' && Object.hasOwn(TAG_REFUSALS, reason)
    ? TAG_REFUSALS[reason as keyof typeof TAG_REFUSALS]
    : UPCOMING_HINTS[error.error];
}

/** A batch of adds, changes and removes (the text editor, and agents through
 * `workers/capture.ts`) validated as a whole before anything is written. A
 * destination may be a city object from the picker or text, "Name" or
 * "Name, Region, Country", resolved through the same city search as the form;
 * qualifiers pick among same-named cities. Problems name their list and index. */
export interface UpcomingChange {
  next: UpcomingEntry | null;
  previous: UpcomingEntry | null;
}
export interface UpcomingBatch {
  add: Item[];
  change: Item[];
  remove: Item[];
}
export const UPCOMING_BATCH_LISTS = ['add', 'change', 'remove'] as const;
export const UPCOMING_BATCH_MAX = UPCOMING_MAX;
export function batchShape(value: Item): UpcomingBatch {
  if (Object.keys(value).some((field) => !['add', 'change', 'remove', 'dry_run'].includes(field)))
    reject(400, 'upcoming-fields');
  const lists = Object.fromEntries(
    UPCOMING_BATCH_LISTS.map((list) => {
      const items = value[list] ?? [];
      if (!Array.isArray(items) || items.some((item) => !item || typeof item !== 'object' || Array.isArray(item)))
        reject(400, 'upcoming-fields', { list });
      return [list, items as Item[]];
    })
  ) as unknown as UpcomingBatch;
  if (lists.add.length + lists.change.length + lists.remove.length > UPCOMING_BATCH_MAX)
    reject(400, 'upcoming-batch', { limit: UPCOMING_BATCH_MAX });
  return lists;
}
export async function resolvePlace(text: string, geocode: (q: string) => Promise<City[]>): Promise<City | null> {
  const [name = '', ...rest] = text.split(',').map((part) => pythonTrim(part)),
    wanted = rest.map(fold).filter(Boolean);
  if (!name) return null;
  let cities: City[];
  try {
    cities = await geocode(name);
  } catch {
    reject(502, 'places-failed');
  }
  const matching = cities.filter((city) =>
    wanted.every((part) => [city.region, city.country].map(fold).includes(part))
  );
  return (wanted.length ? matching : cities)[0] ?? null;
}
export async function prepareUpcomingBatch(
  batch: UpcomingBatch,
  existing: readonly UpcomingEntry[],
  today: string,
  at: string,
  geocode: (q: string) => Promise<City[]>
): Promise<{ changes: UpcomingChange[]; count: Record<(typeof UPCOMING_BATCH_LISTS)[number], number> }> {
  const byId = new Map(existing.map((entry) => [entry.id, entry])),
    seen = new Set<string>(),
    changes: UpcomingChange[] = [];
  const at_ = (list: string, index: number, run: () => UpcomingChange) => {
    try {
      changes.push(run());
    } catch (error) {
      if (error instanceof ApiError) throw new ApiError(error.status, error.error, { ...error.extra, list, index });
      throw error;
    }
  };
  const previousFor = (item: Item, list: string, index: number): UpcomingEntry => {
    const previous = typeof item.id === 'string' ? byId.get(item.id) : undefined;
    if (!previous) reject(404, 'upcoming-missing', { list, index });
    if (seen.has(previous.id)) reject(400, 'upcoming-fields', { list, index });
    seen.add(previous.id);
    // No revision, or one that isn't a whole number, is a malformed item;
    // only a revision that was read and has moved on is a conflict.
    if (!Number.isSafeInteger(item.revision)) reject(400, 'upcoming-fields', { list, index });
    if (item.revision !== previous.revision) reject(409, 'upcoming-changed', { list, index });
    return previous;
  };
  batch.remove.forEach((item, index) => {
    if (Object.keys(item).some((field) => !['id', 'revision'].includes(field)))
      reject(400, 'upcoming-fields', { list: 'remove', index });
    at_('remove', index, () => ({ next: null, previous: previousFor(item, 'remove', index) }));
  });
  for (const list of ['change', 'add'] as const)
    for (const [index, item] of batch[list].entries()) {
      const { id, ...fields } = item,
        previous = list === 'change' ? previousFor(item, list, index) : null;
      if (list === 'add' && (Object.hasOwn(item, 'id') || Object.hasOwn(item, 'revision')))
        reject(400, 'upcoming-fields', { list, index });
      delete fields.revision;
      if (typeof fields.place === 'string') {
        const city = await resolvePlace(fields.place, geocode);
        if (!city) reject(400, 'upcoming-place', { list, index, place: fields.place });
        fields.place = city;
      }
      void id;
      at_(list, index, () => ({
        next: {
          id: previous?.id ?? randomUUID(),
          ...upcomingContent(fields, today, previous),
          revision: (previous?.revision ?? 0) + 1,
          created_at: previous?.created_at ?? at,
          updated_at: at
        },
        previous
      }));
    }
  if (existing.length + batch.add.length - batch.remove.length > UPCOMING_MAX)
    reject(400, 'upcoming-limit', { limit: UPCOMING_MAX });
  return { changes, count: { add: batch.add.length, change: batch.change.length, remove: batch.remove.length } };
}
