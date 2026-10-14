/** Owner-only entry validation. All writes go through the request-local
 * guarded Store, proving the live session/account in the same transaction. */
import { reject } from './sessions.ts';
import { clean } from './places.ts';
import { validDay, parseDay, formatDay } from '../domain/dates.ts';
import { pythonTrim, codePointLength } from '../domain/unicode.ts';
import { MAX_TAG, slug } from '../domain/tags.ts';
import { annual, defaultReminders, UPCOMING_KINDS, UPCOMING_TITLE_MAX, type UpcomingKind } from '../domain/upcoming.ts';
import type { Item } from './store-types.ts';

export function upcomingContent(value: Item, today: string) {
  if (
    Object.keys(value).some(
      (field) =>
        !['kind', 'title', 'tag', 'date', 'year', 'end_date', 'place', 'email', 'reminders', 'revision'].includes(field)
    )
  )
    reject(400, 'upcoming-fields');
  if (!UPCOMING_KINDS.includes(value.kind as UpcomingKind)) reject(400, 'upcoming-kind');
  const kind = value.kind as UpcomingKind;
  if (typeof value.title !== 'string') reject(400, 'upcoming-title');
  const title = pythonTrim(value.title);
  if (!title || codePointLength(title) > UPCOMING_TITLE_MAX || /[\p{Cc}\u2028\u2029]/u.test(title))
    reject(400, 'upcoming-title');
  let tag: string | null = null;
  if (value.tag != null) {
    if (typeof value.tag !== 'string') reject(400, 'upcoming-tag');
    const raw = pythonTrim(value.tag).replace(/^#/, '');
    if (raw) {
      tag = slug(raw);
      if (codePointLength(raw) > MAX_TAG || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(raw) || !/[a-z]/.test(tag))
        reject(400, 'upcoming-tag');
    } else if (pythonTrim(value.tag)) reject(400, 'upcoming-tag');
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
    tag,
    date,
    year: year as number | null,
    end_date: end_date as string | null,
    place,
    email,
    reminders: (reminders as number[]).toSorted((a, b) => b - a)
  };
}
