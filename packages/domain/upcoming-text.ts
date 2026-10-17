/** Upcoming dates as lines of text (Jamie, 2026-10-17: bulk editing "is a lot
 * of clicking"). One date per line: the kind and the date are fixed first
 * tokens, the title is free text, and everything else is marked, so no column
 * has to line up:
 *
 *   birthday 1976-10-20 Alex #family
 *   anniversary 06-14 Our first hike remind:30,7,0
 *   trip 2026-12-05..2026-12-12 Winter break @Zürich, Zurich, Switzerland
 *   event 2026-10-01 Concert email:off
 *
 * Rendering and parsing round-trip; a plan pairs lines with saved entries by
 * kind and folded title so an edited line is a change, not a remove and add. */
import { validDay } from './dates.ts';
import { fold } from './unicode.ts';
import { annual, defaultReminders, UPCOMING_KINDS, type UpcomingEntry, type UpcomingKind } from './upcoming.ts';

export interface TextLine {
  line: number;
  kind: UpcomingKind;
  title: string;
  tag: string | null;
  date: string;
  year: number | null;
  end_date: string | null;
  /** A destination as written, "Name, Region, Country" or just a name. */
  place: string | null;
  /** null keeps a matched entry's setting, or the default for a new one. */
  email: boolean | null;
  reminders: number[] | null;
}
export interface TextProblem {
  line: number;
  problem: string;
}
export const TEXT_HEADER = [
  '# One date per line: kind, date, title, then any of #tag @destination email:off remind:30,7,0',
  '# Kinds: birthday, anniversary (dates MM-DD or YYYY-MM-DD), trip (YYYY-MM-DD..YYYY-MM-DD), event (YYYY-MM-DD).',
  '# Delete a line to remove that date. Lines starting with # are notes to yourself.'
];
const KIND_ORDER: Record<UpcomingKind, number> = { birthday: 0, anniversary: 1, trip: 2, event: 3 };
const DAY = /^\d{4}-\d{2}-\d{2}$/,
  MONTH_DAY = /^\d{2}-\d{2}$/,
  OPTION = /\s+(?=#\S|@\S|email:|remind:)/i;

export const placeText = (place: UpcomingEntry['place']) =>
  place ? [place.name, place.region, place.country].filter(Boolean).join(', ') : null;
const sameReminders = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((n, i) => n === b[i]);
const quoted = (title: string) => (/^"|[#@]\S|\b(?:email|remind):/i.test(title) ? `"${title}"` : title);

/** One line per entry, the kinds in order then by date and title. */
export function upcomingLine(entry: UpcomingEntry): string {
  const date = annual(entry.kind)
    ? (entry.year === null ? '' : String(entry.year).padStart(4, '0') + '-') + entry.date
    : entry.kind === 'trip' && entry.end_date && entry.end_date !== entry.date
      ? entry.date + '..' + entry.end_date
      : entry.date;
  const parts = [entry.kind, date, quoted(entry.title)];
  if (entry.tag) parts.push('#' + entry.tag);
  if (entry.place) parts.push('@' + placeText(entry.place));
  if (!entry.email) parts.push('email:off');
  if (!sameReminders(entry.reminders, defaultReminders(entry.kind))) parts.push('remind:' + entry.reminders.join(','));
  return parts.join(' ');
}
export function upcomingText(entries: readonly UpcomingEntry[]): string {
  const sorted = entries.toSorted(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.date.localeCompare(b.date) || a.title.localeCompare(b.title)
  );
  return [...TEXT_HEADER, '', ...sorted.map(upcomingLine)].join('\n') + '\n';
}

function parseDate(kind: UpcomingKind, spec: string): Pick<TextLine, 'date' | 'year' | 'end_date'> | string {
  const range = spec.split('..');
  if (range.length > 2) return 'Write a trip as start..end, for example 2026-12-05..2026-12-12.';
  if (range.length === 2) {
    if (kind !== 'trip') return 'Only a trip has an end date; give one date.';
    const [start, end] = range as [string, string];
    if (!DAY.test(start) || !validDay(start) || !DAY.test(end) || !validDay(end)) return 'Use dates like 2026-12-05.';
    if (end < start) return 'The end date comes before the start.';
    return { date: start, year: null, end_date: end };
  }
  if (annual(kind)) {
    if (MONTH_DAY.test(spec) && validDay('2000-' + spec)) return { date: spec, year: null, end_date: null };
    if (DAY.test(spec) && validDay(spec))
      return { date: spec.slice(5), year: Number(spec.slice(0, 4)), end_date: null };
    return 'Use a date like 10-20, or 1976-10-20 to include the year.';
  }
  if (!DAY.test(spec) || !validDay(spec)) return 'Use a date like 2026-10-20.';
  return { date: spec, year: null, end_date: kind === 'trip' ? spec : null };
}
function parseOptions(rest: string, out: TextLine): string | null {
  const parts = rest.split(OPTION).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith('#')) {
      if (out.tag !== null) return 'One tag per date.';
      if (/\s/.test(part)) return `A tag is one word: ${part}.`;
      out.tag = part.slice(1);
    } else if (part.startsWith('@')) {
      if (out.place !== null) return 'One destination per trip.';
      out.place = part.slice(1).trim();
    } else if (/^email:/i.test(part)) {
      const value = part.slice(6).trim().toLowerCase();
      if (!['on', 'off', 'yes', 'no'].includes(value) || /\s/.test(part)) return 'Write email:on or email:off.';
      out.email = value === 'on' || value === 'yes';
    } else if (/^remind:/i.test(part)) {
      const numbers = part.slice(7).trim().split(',');
      if (/\s/.test(part) || numbers.some((n) => !/^\d{1,3}$/.test(n) || Number(n) > 365))
        return 'Write reminders as days before, like remind:30,7,0.';
      out.reminders = numbers.map(Number);
    } else return `Unexpected text after the title: “${part}”.`;
  }
  return null;
}
/** Every non-comment line becomes a TextLine or a problem naming its line. */
export function parseUpcomingText(text: string): { lines: TextLine[]; problems: TextProblem[] } {
  const lines: TextLine[] = [],
    problems: TextProblem[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const source = raw.trim(),
      line = index + 1,
      problem = (problem: string) => problems.push({ line, problem });
    if (!source || source.startsWith('#')) return;
    const [kindWord = '', spec = '', ...rest] = source.split(/\s+/),
      kind = kindWord.toLowerCase() as UpcomingKind;
    if (!UPCOMING_KINDS.includes(kind))
      return problem(`Start with birthday, anniversary, trip or event, not “${kindWord}”.`);
    const when = parseDate(kind, spec);
    if (typeof when === 'string') return problem(when);
    let remainder = rest.join(' '),
      title: string;
    if (remainder.startsWith('"')) {
      const close = remainder.indexOf('"', 1);
      if (close < 0) return problem('Close the quoted title with a second ".');
      title = remainder.slice(1, close).trim();
      remainder = remainder.slice(close + 1);
    } else {
      const cut = remainder.search(OPTION);
      title = (cut < 0 ? remainder : remainder.slice(0, cut)).trim();
      remainder = cut < 0 ? '' : remainder.slice(cut);
    }
    if (!title) return problem('Give the date a title after the date.');
    const out: TextLine = {
      line,
      kind,
      title,
      tag: null,
      ...when,
      place: null,
      email: null,
      reminders: null
    };
    const wrong = parseOptions(remainder.trim(), out);
    if (wrong) return problem(wrong);
    if (out.place !== null && out.place === '') return problem('Name the destination after @.');
    if (kind === 'trip' && out.place === null)
      return problem('A trip needs a destination: @City, or @City, Region, Country.');
    if (annual(kind) && out.place !== null) return problem('Only a trip has a destination.');
    lines.push(out);
  });
  return { lines, problems };
}

export interface TextPlan {
  add: TextLine[];
  change: { entry: UpcomingEntry; line: TextLine }[];
  remove: UpcomingEntry[];
  unchanged: number;
}
const sameDate = (entry: UpcomingEntry, line: TextLine) =>
  entry.date === line.date && entry.year === line.year && entry.end_date === line.end_date;
export function lineChanges(entry: UpcomingEntry, line: TextLine): boolean {
  return (
    entry.title !== line.title ||
    (entry.tag ?? null) !== (line.tag === null ? null : line.tag.toLowerCase()) ||
    !sameDate(entry, line) ||
    placeText(entry.place) !== line.place ||
    (line.email !== null && entry.email !== line.email) ||
    (line.reminders !== null &&
      !sameReminders(
        entry.reminders,
        line.reminders.toSorted((a, b) => b - a)
      ))
  );
}
/** Pair lines with entries of the same kind and folded title, exact dates
 * first, then in order; what is left is added or removed. */
export function planUpcomingText(lines: readonly TextLine[], entries: readonly UpcomingEntry[]): TextPlan {
  const key = (kind: string, title: string) => kind + '\n' + fold(title),
    groups = new Map<string, UpcomingEntry[]>();
  for (const entry of entries) {
    const k = key(entry.kind, entry.title);
    groups.set(k, [...(groups.get(k) ?? []), entry]);
  }
  const plan: TextPlan = { add: [], change: [], remove: [], unchanged: 0 },
    pending = new Map<string, TextLine[]>();
  for (const line of lines) {
    const k = key(line.kind, line.title);
    pending.set(k, [...(pending.get(k) ?? []), line]);
  }
  for (const [k, group] of pending) {
    const left = groups.get(k) ?? [];
    groups.delete(k);
    const paired = new Set<TextLine>();
    for (const line of group) {
      const i = left.findIndex((entry) => sameDate(entry, line));
      if (i < 0) continue;
      const [entry] = left.splice(i, 1);
      paired.add(line);
      if (lineChanges(entry!, line)) plan.change.push({ entry: entry!, line });
      else plan.unchanged++;
    }
    for (const line of group) {
      if (paired.has(line)) continue;
      const entry = left.shift();
      if (entry) plan.change.push({ entry, line });
      else plan.add.push(line);
    }
    plan.remove.push(...left);
  }
  for (const left of groups.values()) plan.remove.push(...left);
  return plan;
}
/** The batch request the plan makes: adds and changes carry the line's fields
 * (a destination as text, resolved by the server), removes the id and revision. */
export function batchFor(plan: TextPlan) {
  const fields = (line: TextLine, entry?: UpcomingEntry) => ({
    kind: line.kind,
    title: line.title,
    tag: line.tag,
    date: line.date,
    year: line.year,
    end_date: line.end_date,
    place: line.place,
    email: line.email ?? entry?.email ?? true,
    reminders: line.reminders ?? entry?.reminders ?? defaultReminders(line.kind)
  });
  return {
    add: plan.add.map((line) => fields(line)),
    change: plan.change.map(({ entry, line }) => ({ id: entry.id, revision: entry.revision, ...fields(line, entry) })),
    remove: plan.remove.map((entry) => ({ id: entry.id, revision: entry.revision }))
  };
}
