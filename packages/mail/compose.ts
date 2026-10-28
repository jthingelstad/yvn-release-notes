/** The same daily email in plain text and HTML. Type on paper, nothing
 * remote. Photos are bounded thumbnail-only MIME related parts. HTML uses
 * ASCII entities, and note links are the shared named-link renderer. */
import { randomBytes, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import * as links from '../backend/links.ts';
import { withoutClosing } from '../domain/tags.ts';
import { daysBetween } from '../domain/dates.ts';
import { computeVersion, releaseName, releaseSpan, type Version } from '../domain/version.ts';
import type { Streak } from '../domain/streak.ts';
import { codePointLength, codePointSlice, pythonRstrip, pythonTrim } from '../domain/unicode.ts';
import { UPDATE_LABEL, type ProductUpdate } from '../domain/product-updates.ts';
import type { UpcomingSection } from '../domain/upcoming.ts';
import { specialKinds } from '../domain/badges.ts';
import { givingLine } from '../domain/giving.ts';
export const SITE = 'https://yourversionnumber.com',
  APP = 'https://notes.yourversionnumber.com';
export const PAPER = '#fffbf2',
  INK = '#14163a',
  INK_2 = '#3b3d63',
  BLUE = '#1a4fe0',
  ORANGE = '#ff5a1f',
  ORANGE_INK = '#c43c00',
  PINK_INK = '#c9186a';
export const FONT = "'Bricolage Grotesque',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif",
  MONO = "'Martian Mono',ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";
// The site's kicker, and its action link: cobalt words with no underline,
// on a line of their own. Links inside a sentence keep their underline.
export const KICKER = `font-family:${MONO};font-size:12px;line-height:1.5;letter-spacing:0.1em;text-transform:uppercase;color:${INK_2};`;
export const action = (href: string, label: string, size = 15) =>
  `<a class="link" href="${href}" style="color:${BLUE};font-family:${FONT};font-size:${size}px;font-weight:700;text-decoration:none;">${label}</a>`;
export const MAIL_TAG = 'release-notes-mail',
  PAST_MAX = 1000,
  SHOWN = 4,
  PHOTOS_A_DAY = 4,
  PHOTOS_AN_EMAIL = 6,
  PHOTO_BYTES = 400 * 1024,
  YESTERDAY_MAX = 1000,
  DOTS = 24,
  STREAK_SHOWN = 6;
export const CREDIT = 'Weather from Open-Meteo',
  CREDIT_URL = 'https://open-meteo.com/';
export type Files = Record<string, number>;
export interface Inline {
  cid: string;
  alt: string;
  width: number;
  height: number;
}
export interface Thumbnail {
  key: string;
  size: number;
  width: number;
  height: number;
  alt: string;
}
export interface PastDay {
  day: string;
  text: string;
  links?: links.Link[];
  files?: Files;
  sky?: string | null;
  tags: string[];
  thumbs: Thumbnail[];
  photos: Inline[];
}
export interface OnThisDay {
  shown: PastDay[];
  more: string[];
}
export interface Lifetime {
  notes: number;
  days: number;
  photos: number;
  since: number;
}
export interface Closed {
  age: number;
  days: number;
  notes: number;
  photos: number;
  longest: number;
  /** The release's badges, with "Show badges" on (docs/BADGES.md). */
  badges?: { coverage: string | null; collected: { name: string; count: number }[] } | null;
  /** The nonprofits given to as a Weekly Thing Supporting Member while the
   * release ran (domain/giving.ts), whatever "Show badges" says. */
  giving?: string[];
}
/** A badge earned and not yet celebrated, oldest first. */
export interface NewBadge {
  name: string;
  version: string;
}
export interface Yesterday extends Omit<PastDay, 'sky'> {
  others: number;
  places: [string, string | null][];
}
export interface BodyOptions {
  upcoming?: UpcomingSection | null;
  productUpdate?: ProductUpdate | null;
  streak?: Streak | null;
  past?: OnThisDay | null;
  forecast?: string | null;
  welcome?: string | null;
  token?: string | null;
  lifetime?: Lifetime | null;
  yesterday?: Yesterday | null;
  inbox?: string | null;
  closed?: Closed | null;
  /** Set with "Show badges" on: the special-day clause shows, and `news`
   * (empty when nothing is new, or it could not be read) gets one line. */
  badges?: { news: NewBadge[] } | null;
}
const FILE_WORDS = [
  ['image', 'photo'],
  ['audio', 'recording'],
  ['file', 'file']
] as const;
export function newToken(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0,
    value = 0,
    out = '';
  for (const b of randomBytes(15)) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  return out;
}
export const fromHeader = (address: string) => `Release Notes <${address}>`;
export const replyAddress = (token: string, domain: string) => `n-${token}@${domain}`;
export const standingAddress = (token: string, domain: string) => `${token}@${domain}`;
export const subject = (v: Version) => `You're ${v} today`;
export const birthdayLine = (v: Version) =>
  v.patch === 0
    ? v.minor === 0 && v.major > 0
      ? 'Happy birthday: a major release.'
      : 'Happy birthday: a new release.'
    : null;
export const nextRelease = (v: Version) => `${Math.floor((v.age + 1) / 10)}.${(v.age + 1) % 10}.0`;
export const ships = (v: Version) => (v.daysUntil === 1 ? 'tomorrow' : `in ${v.daysUntil} days`);
export const countdown = (v: Version) => `${nextRelease(v)} ships ${ships(v)}.`;
/** Weeks and days lived, a nod to Four Thousand Weeks. Both count from 1, so
 * the day you were born is Week 1, Day 1 (the version counts from 0). */
export function lifeCount(v: Version, birthday: string): [number, number] {
  const lived = daysBetween(birthday, releaseSpan(birthday, v.age)[0]) + v.patch;
  return [Math.floor(lived / 7) + 1, lived + 1];
}
export const lifeLine = (v: Version, birthday: string, dash = '\u2014') =>
  lifeCount(v, birthday)
    .map((n, i) => `${i ? 'Day' : 'Week'} ${n.toLocaleString('en-US')}`)
    .join(` ${dash} `);
export const daysPhrase = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
export function clockPhrase(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h! + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`;
}
export const welcomeLine = (sendTime: string, from: string) =>
  `Welcome to Release Notes. This first one is today's; from tomorrow it comes every day at ${clockPhrase(sendTime)}. Add ${from} to your contacts so it never lands in junk.`;
export function streakLines(v: Version, s: Streak): [string, string] {
  if (!s.current)
    return [
      'Every reply starts a streak.',
      s.longest ? `Your longest so far is ${daysPhrase(s.longest)}.` : "Today's can be the first."
    ];
  const ask = `Reply today and ${v} makes it ${s.current + 1}.`;
  if (s.current >= s.longest && s.current > 1) return [`${daysPhrase(s.current)} in a row, your longest yet.`, ask];
  return [
    `${daysPhrase(s.current)} in a row.`,
    (s.longest > s.current ? `Your longest is ${daysPhrase(s.longest)}. ` : '') + ask
  ];
}
export function longDate(day: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${day}T12:00:00Z`)
  );
}
export const whereLine = (places: readonly [string, string | null][]) =>
  places.length ? 'Where: ' + places.map(([name, url]) => (url ? `${name} <${url}>` : name)).join('; ') : '';
export const countPhrase = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
export const lifetimeLine = (life: Lifetime) =>
  `${countPhrase(life.notes, 'note', 'notes')} across ${countPhrase(life.days, 'day', 'days')} since ${life.since}` +
  (life.photos ? `, and ${countPhrase(life.photos, 'photo', 'photos')}.` : '.');
export const releaseLink = (age: number) => `${APP}/release/?v=${releaseName(age)}`;
export const listed = (names: readonly string[]) =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
export const closedBadges = (b: NonNullable<Closed['badges']>) =>
  (b.coverage ? ` Coverage: ${b.coverage}.` : '') +
  (b.collected.length
    ? ` Collected: ${listed(b.collected.map((c) => (c.count > 1 ? `${c.name} \u00d7${c.count}` : c.name)))}.`
    : '');
export const closedLine = (c: Closed) =>
  `${countPhrase(c.days, 'day', 'days')} with notes, ${countPhrase(c.notes, 'note', 'notes')}` +
  (c.photos ? ` and ${countPhrase(c.photos, 'photo', 'photos')}.` : '.') +
  (c.longest > 1 ? ` Longest streak: ${countPhrase(c.longest, 'day', 'days')}.` : '') +
  (c.badges ? closedBadges(c.badges) : '');
export const BADGES_LINK = `${APP}/badges/`;
/** At most this many names, then "and N more" (a long import's first morning). */
export const NEWS_NAMED = 4;
/** One line for what was earned and not yet celebrated (docs/BADGES.md, The
 * email): a single badge with its version, several by name. Never what is
 * close, at risk or missed. */
export function newsLine(news: readonly NewBadge[]): string | null {
  if (!news.length) return null;
  if (news.length === 1) return `New badge: ${news[0]!.name}, ${news[0]!.version}.`;
  const names = news.map((n) => n.name),
    shown =
      names.length > NEWS_NAMED ? [...names.slice(0, NEWS_NAMED - 1), `${names.length - NEWS_NAMED + 1} more`] : names;
  return `New badges: ${listed(shown)}.`;
}
/** The clause beside the number on a special day that is not secret. A
 * birthday's email celebrates the release already, so x.y.0 has none. */
export function specialLine(v: Version): string | null {
  if (!v.patch) return null;
  const kinds = specialKinds(v.major, v.minor, v.patch, v.cycleDays),
    said = [
      ...(kinds.includes('round') ? ['is a round number'] : []),
      ...(kinds.includes('palindrome') ? ['reads the same both ways'] : []),
      ...(kinds.includes('code-freeze') ? [`is the last patch of ${v.major}.${v.minor}`] : [])
    ];
  return said.length ? `${v} ${said.join(' and ')}.` : null;
}
const closedGiving = (c: Closed) => (c.giving?.length ? givingLine(releaseName(c.age), c.giving) : null);
export const closedBody = (c: Closed) => {
  const giving = closedGiving(c);
  return `${releaseName(c.age)} is closed${c.notes ? `: ${closedLine(c)}` : '.'}\n${giving ? `${giving}\n` : ''}See ${releaseName(c.age)}: ${releaseLink(c.age)}\n\n`;
};
export function pastText(text: string, limit = PAST_MAX): [string, boolean] {
  if (codePointLength(text) <= limit) return [text, false];
  const prefix = codePointSlice(text, 0, limit),
    match = /\s+\S*\s*$/.exec(prefix);
  return [match ? pythonRstrip(prefix.slice(0, match.index)) : '', true];
}
const sentenceEnd = /[.!?…]["'”’)\]]*(?=\s)|\n\s*\n/g,
  endsSentence = /[.!?…]["'”’)\]]*$/;
export function sentenceText(text: string, limit = YESTERDAY_MAX): [string, boolean] {
  if (codePointLength(text) <= limit) return [text, false];
  const prefix = codePointSlice(text, 0, limit + 1),
    end = [...prefix.matchAll(sentenceEnd)].at(-1);
  if (end && codePointLength(prefix.slice(0, end.index + end[0].length)) > Math.floor(limit / 3))
    return [pythonRstrip(prefix.slice(0, end.index + end[0].length)), true];
  return pastText(text, limit);
}
export function filesLine(files?: Files, others = 0): string {
  const parts = FILE_WORDS.filter(([kind]) => files?.[kind]).map(([kind, word]) =>
    countPhrase(files![kind]!, word, word + 's')
  );
  if (others) parts.push(countPhrase(others, 'attachment', 'attachments') + ' in the original email');
  return parts.join(', ');
}
export const pastLink = (day: string) => `${APP}/day/?d=${day}`;
// Our Map page, opened on a note's spot, or on a day's own place (`ll`,
// since no note there need have a spot) with that day's notes (Jamie,
// 2026-10-24: place links go to our map, not Apple's). It all rides in the
// #, so no server sees which.
export const mapLink = (day: string, at: { id: string } | { ll: string }) =>
  `${APP}/map/#${new URLSearchParams('id' in at ? { d: day, n: at.id } : { d: day, ll: at.ll }).toString()}`;
export const tagLink = (tag: string) => `${APP}/tag/?t=${tag}`;
export const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c]!);
export const asciiHtml = (text: string) =>
  Array.from(escape(text), (c) => (c.codePointAt(0)! > 127 ? `&#${c.codePointAt(0)};` : c)).join('');
export function linked(text: string, found?: links.Link[]): string {
  return links
    .segments(text, found)
    .map((seg) =>
      typeof seg === 'string'
        ? asciiHtml(seg)
        : `<a class="link" href="${asciiHtml(seg.url)}" style="color:${BLUE};">${asciiHtml(seg.label)}</a>` +
          (seg.site ? `<span class="ink-2" style="color:${INK_2};"> &middot; ${asciiHtml(seg.site)}</span>` : '')
    )
    .join('');
}
export function filesPhrase(files?: Files): string {
  const parts: string[] = [];
  for (const [kind, word] of FILE_WORDS) {
    const n = files?.[kind] ?? 0;
    if (n) parts.push(n > 1 ? `${n} ${word}s` : parts.length ? `a ${word}` : `the ${word}`);
  }
  return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts.at(-1) : (parts[0] ?? '');
}
export function pastMore(cut: boolean, files?: Files, name = 'it'): string {
  const phrase = filesPhrase(files);
  if (cut) return phrase ? `Read the rest, with ${phrase}` : 'Read the rest';
  if (!phrase) return `See ${name}`;
  const kinds = Object.keys(files ?? {}).filter((k) => files![k]);
  return `${kinds.length === 1 && kinds[0] === 'audio' ? 'Hear' : 'See'} ${phrase}`;
}
export function unshown(files: Files | undefined, photos: Inline[]): Files {
  const out = { ...files };
  if (photos.length && photos.length >= (out.image ?? 0)) out.image = 0;
  return out;
}
export const yearsAgo = (v: Version, then: Version) =>
  v.age - then.age === 1 ? 'A year ago' : `${v.age - then.age} years ago`;
export const sectionLede = (v: Version, past: OnThisDay) =>
  `${past.shown.length + past.more.length === 1 ? 'One earlier release has' : `${past.shown.length + past.more.length} earlier releases have`} notes for day ${v.patch}.`;
export const budget = (past: OnThisDay) => Math.floor(PAST_MAX / Math.max(1, past.shown.length));
export const shownText = (p: PastDay, limit: number) => pastText(withoutClosing(p.text), limit);
export function pastBody(v: Version, birthday: string, past: OnThisDay): string {
  const out = [`On this day: ${sectionLede(v, past)}\n\n`];
  for (const p of past.shown) {
    const then = computeVersion(birthday, p.day),
      [text, cut] = shownText(p, budget(past)),
      shown = links.plain(text, p.links);
    out.push(
      `${yearsAgo(v, then)} you were ${then} (${longDate(p.day)}, ${p.day.slice(0, 4)}):\n` +
        (p.sky ? `${p.sky}.\n` : '') +
        '\n' +
        (shown ? `${shown}${cut ? ' ...' : ''}\n\n` : '') +
        (p.tags.length ? p.tags.map((t) => `#${t}`).join(' ') + '\n\n' : '') +
        `${pastMore(cut, p.files, String(then))}: ${pastLink(p.day)}\n\n`
    );
  }
  if (past.more.length)
    out.push(
      `And ${past.more.length} more:\n` + past.more.map((d) => `${d.slice(0, 4)}: ${pastLink(d)}\n`).join('') + '\n'
    );
  return out.join('');
}
export const yesterdayShown = (y: Yesterday) => sentenceText(withoutClosing(y.text));
export const cutMark = (shown: string, cut: boolean) => (cut && shown && !endsSentence.test(shown) ? '…' : '');
export function yesterdayBody(birthday: string, y: Yesterday): string {
  const then = computeVersion(birthday, y.day),
    [text, cut] = yesterdayShown(y),
    shown = links.plain(text, y.links),
    files = filesLine(y.files, y.others);
  return (
    `Yesterday you were ${then} (${longDate(y.day)}):\n\n` +
    (y.places.length ? `${whereLine(y.places)}\n\n` : '') +
    (shown ? `${shown}${cutMark(shown, cut) ? ' ...' : ''}\n\n` : '') +
    (y.tags.length ? y.tags.map((t) => `#${t}`).join(' ') + '\n\n' : '') +
    (files ? files + '\n' : '') +
    `${cut ? 'Read the rest' : `See ${then}`}: ${pastLink(y.day)}\n\n`
  );
}
export const credited = (forecast?: string | null, past?: OnThisDay | null) =>
  Boolean(forecast || past?.shown.some((p) => p.sky));
export const unsubscribeLink = (token: string) => `${APP}/unsubscribe/#t=${token}`;
export function body(v: Version, birthday: string, o: BodyOptions = {}): string {
  let opening = `You're ${v} today.`;
  if (birthdayLine(v)) opening += ' ' + birthdayLine(v);
  const special = o.badges ? specialLine(v) : null,
    news = o.badges ? newsLine(o.badges.news) : null;
  if (special) opening += ' ' + special;
  if (o.forecast) opening += '\n' + o.forecast;
  if (o.welcome) opening = o.welcome + '\n\n' + opening;
  if (o.productUpdate)
    opening += `\n\n${UPDATE_LABEL}\n${o.productUpdate.title}\n\n${links.plain(o.productUpdate.text, o.productUpdate.links)}`;
  let text = o.streak ? streakLines(v, o.streak).join(' ') + '\n' : '';
  if (o.lifetime) text += lifetimeLine(o.lifetime) + '\n';
  if (news) text += `${news} See your badges: ${BADGES_LINK}\n`;
  if (text) text += '\n';
  if (o.upcoming?.shown.length) text += upcomingBody(o.upcoming);
  if (o.closed) text += closedBody(o.closed);
  if (o.yesterday) text += yesterdayBody(birthday, o.yesterday);
  if (o.past) text += pastBody(v, birthday, o.past);
  return (
    `${opening}\n\nReply any time today: what happened, what you made, who you saw.\nWhatever you send back becomes the release notes for ${v}.\nPhotos and voice memos work too.\nReply as often as you like; it all adds up to today's notes.\n\n${text}${countdown(v)}\n${lifeLine(v, birthday)}\n${SITE}/birthday/?p=${birthday}\n\n-- \nRelease Notes, from Your Version Number\n` +
    (o.inbox ? `Write any day, no reply needed: ${o.inbox}\n` : '') +
    `Pause or manage: ${APP}/settings/\n` +
    (o.token ? `Unsubscribe: ${unsubscribeLink(o.token)}\n` : '') +
    (credited(o.forecast, o.past) ? `${CREDIT}: ${CREDIT_URL}\n` : '')
  );
}
export function upcomingBody(section: UpcomingSection): string {
  return `Upcoming\n\n${section.shown.map((r) => `${r.when}\n${r.line}\n`).join('\n')}\n${section.more ? `And ${section.more} more today.\n` : ''}See all upcoming: ${APP}/upcoming/\n\n`;
}
export function upcomingHtml(section?: UpcomingSection | null): string {
  if (!section?.shown.length) return '';
  return `<tr><td style="padding:48px 0 0;font-family:${FONT};color:${INK};">
<p class="ink" style="margin:0 0 12px;font-size:22px;line-height:1.2;font-weight:800;color:${INK};">Upcoming</p>
${section.shown.map((r) => `<p class="ink-2" style="margin:0;${KICKER}">${asciiHtml(r.when)}</p>\n<p class="ink" style="margin:0 0 14px;font-size:17px;line-height:1.5;color:${INK};">${asciiHtml(r.line)}</p>`).join('\n')}
${section.more ? `<p class="ink-2" style="margin:0 0 4px;font-size:15px;line-height:1.45;color:${INK_2};">And ${section.more} more today.</p>\n` : ''}<p style="margin:0;">${action(`${APP}/upcoming/`, 'See all upcoming')}</p>
</td></tr>`;
}
export function vnumHtml(v: Version, size: number, sepColor = ORANGE): string {
  return `<span class="vnum" style="font-family:${MONO};font-weight:700;font-size:${size}px;line-height:1;letter-spacing:-0.045em;color:${BLUE};white-space:nowrap;">${String(v).replace(/\./g, `<span class="sep" style="color:${sepColor};">.</span>`)}</span>`;
}
function roundEven(n: number): number {
  const floor = Math.floor(n);
  return n - floor === 0.5 ? floor + (floor % 2) : Math.round(n);
}
export function yearDots(v: Version): string {
  const on = roundEven((v.patch / v.cycleDays) * DOTS);
  return `<p aria-hidden="true" style="margin:0;font-family:${MONO};font-size:11px;line-height:1;letter-spacing:4px;white-space:nowrap;"><span class="dot-on" style="color:${ORANGE};">${'&#9679;'.repeat(on)}</span><span class="dot-off" style="color:#e3e8f7;">${'&#9679;'.repeat(DOTS - on)}</span></p>`;
}
export function newsHtml(news: readonly NewBadge[], after: boolean): string {
  const line = newsLine(news);
  if (!line) return '';
  const [label, rest] = [line.slice(0, line.indexOf(':') + 1), line.slice(line.indexOf(':') + 2)],
    shown =
      news.length === 1
        ? `<strong class="ink" style="color:${INK};">${asciiHtml(news[0]!.name)}</strong>, <span class="vnum" style="font-family:${MONO};font-weight:700;letter-spacing:-0.03em;color:${BLUE};white-space:nowrap;">${escape(news[0]!.version)}</span>.`
        : `<strong class="ink" style="color:${INK};">${asciiHtml(rest.slice(0, -1))}</strong>.`;
  return `<p class="ink-2" id="badge-news" style="margin:${after ? 10 : 0}px 0 0;font-family:${FONT};font-size:15px;line-height:1.45;color:${INK_2};">${label} ${shown} <a class="link" href="${BADGES_LINK}" style="color:${BLUE};font-weight:700;text-decoration:underline;white-space:nowrap;">See your badges</a></p>\n`;
}
export function streakHtml(
  v: Version,
  birthday: string,
  s?: Streak | null,
  life?: Lifetime | null,
  news: readonly NewBadge[] = []
): string {
  if (!s && !life && !news.length) return '';
  const parts: string[] = [];
  if (s) {
    const past = s.days
        .slice(-STREAK_SHOWN)
        .map(
          (d) =>
            `<span class="vnum" style="font-weight:700;color:${BLUE};">${computeVersion(birthday, d).patch}</span><span class="sep" style="color:${ORANGE};"> &middot; </span>`
        )
        .join(''),
      today = `<span class="today" style="font-weight:700;color:${ORANGE_INK};text-decoration:underline;text-decoration-style:dotted;text-underline-offset:5px;">${v.patch}</span>`;
    if (s.days.length)
      parts.push(
        `<p class="streak-row" style="margin:0 0 8px;font-family:${MONO};font-size:17px;line-height:1.5;letter-spacing:-0.02em;">${past}${today}</p>\n`
      );
    const [head, tail] = streakLines(v, s),
      i = tail.lastIndexOf(' ');
    parts.push(
      `<p class="ink-2" style="margin:0;font-family:${FONT};font-size:15px;line-height:1.45;color:${INK_2};">\n<strong class="ink" style="color:${INK};">${escape(head)}</strong> ${i < 0 ? escape(tail) : escape(tail.slice(0, i)) + '&nbsp;' + escape(tail.slice(i + 1))}\n</p>\n`
    );
  }
  if (life)
    parts.push(
      `<p class="ink-2" style="margin:${s ? 10 : 0}px 0 0;font-family:${FONT};font-size:15px;line-height:1.45;color:${INK_2};">${asciiHtml(lifetimeLine(life))}</p>\n`
    );
  parts.push(newsHtml(news, Boolean(s || life)));
  return `<tr><td style="padding:36px 0 0;">\n${parts.join('')}</td></tr>\n`;
}
export function notesHtml(shown: string, found?: links.Link[], mark = ''): string {
  const paras = shown
    .split(/\n\s*\n/)
    .map(pythonTrim)
    .filter(Boolean);
  return paras
    .map(
      (p, i) =>
        `<p class="ink" style="margin:0 0 12px;font-family:${FONT};font-size:17px;line-height:1.5;color:${INK};">` +
        p
          .split('\n')
          .map((line) => linked(line, found))
          .join('<br>') +
        (mark && i === paras.length - 1 ? asciiHtml(mark) : '') +
        '</p>\n'
    )
    .join('');
}
export const imgHtml = (p: Inline, width: number) =>
  `<img src="cid:${escape(p.cid)}" alt="${asciiHtml(p.alt)}" width="${Math.min(width, p.width)}" style="display:block;width:100%;max-width:${Math.min(width, p.width)}px;height:auto;">`;
export function photosHtml(photos: Inline[]): string {
  if (!photos.length) return '';
  if (photos.length === 1) return `<p style="margin:0 0 12px;">${imgHtml(photos[0]!, 520)}</p>\n`;
  const rows: string[] = [];
  for (let i = 0; i < photos.length; i += 2) {
    const pair = photos.slice(i, i + 2);
    let cells = pair
      .map(
        (p, j) =>
          `<td width="50%" valign="top" style="padding:0 ${j === 0 ? 4 : 0}px 8px ${j === 1 ? 4 : 0}px;">${imgHtml(p, 254)}</td>`
      )
      .join('');
    if (pair.length === 1) cells += '<td width="50%"></td>';
    rows.push(`<tr>${cells}</tr>`);
  }
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px;">' +
    rows.join('') +
    '</table>\n'
  );
}
export function tagsHtml(tags: string[]): string {
  return tags.length
    ? `<p style="margin:0 0 10px;font-family:${FONT};font-size:14px;line-height:1.6;">` +
        tags
          .map(
            (t) =>
              `<a class="link" href="${escape(tagLink(t))}" style="color:${BLUE};text-decoration:none;">#${escape(t)}</a>`
          )
          .join(' ') +
        '</p>\n'
    : '';
}

export const DARK_CSS = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (max-width: 480px) {
  .vnum-hero .vnum { font-size: 58px !important; }
  .streak-row { font-size: 15px !important; }
}
@media (prefers-color-scheme: dark) {
  body, .paper { background: #14163a !important; }
  .ink { color: #fffbf2 !important; }
  .ink-2 { color: #c9cbe6 !important; }
  .vnum { color: #8fb0ff !important; }
  .sep, .dot-on { color: #ff8a5c !important; }
  .dot-off { color: #2b3062 !important; }
  .today { color: #ffab6b !important; }
  .party { color: #ff9ecb !important; }
  .link { color: #8fb0ff !important; }
}
`;

export function closedHtml(c: Closed): string {
  const giving = closedGiving(c),
    name = escape(releaseName(c.age)).replace(/\./g, `<span class="sep" style="color:${ORANGE_INK};">.</span>`);
  return `<tr><td style="padding:48px 0 0;">
<p class="ink" style="margin:0 0 8px;font-family:${FONT};font-size:22px;line-height:1.2;font-weight:800;color:${INK};"><span class="vnum" style="font-family:${MONO};letter-spacing:-0.03em;color:${BLUE};white-space:nowrap;">${name}</span> is closed</p>
${c.notes ? `<p class="ink-2" style="margin:0 0 8px;font-family:${FONT};font-size:15px;line-height:1.45;color:${INK_2};">${asciiHtml(closedLine(c))}</p>\n` : ''}${giving ? `<p class="ink-2" style="margin:0 0 8px;font-family:${FONT};font-size:15px;line-height:1.45;color:${INK_2};">${asciiHtml(giving)}</p>\n` : ''}<p style="margin:0;">${action(escape(releaseLink(c.age)), `See ${escape(releaseName(c.age))}`)}</p>
</td></tr>
`;
}

export function yesterdayHtml(birthday: string, y: Yesterday): string {
  const then = computeVersion(birthday, y.day),
    [shown, cut] = yesterdayShown(y),
    files = filesLine(y.files, y.others),
    filesHtml = files
      ? `<p class="ink-2" style="margin:0 0 10px;font-family:${FONT};font-size:14px;line-height:1.45;color:${INK_2};">${escape(files)}</p>\n`
      : '',
    whereHtml = y.places.length
      ? `<p class="ink-2" style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:1.45;color:${INK_2};">Where: ` +
        y.places
          .map(([name, url]) =>
            url
              ? `<a class="link" href="${escape(url)}" style="color:${BLUE};text-decoration:underline;">${asciiHtml(name)}</a>`
              : asciiHtml(name)
          )
          .join('; ') +
        '</p>\n'
      : '';
  return `<tr><td style="padding:48px 0 0;">
<p class="ink" style="margin:0 0 12px;font-family:${FONT};font-size:22px;line-height:1.2;font-weight:800;color:${INK};">Yesterday</p>
<p class="ink-2" style="margin:0 0 6px;${KICKER}">${escape(longDate(y.day))}</p>
<p style="margin:0 0 12px;">${vnumHtml(then, 26)}</p>
${whereHtml}${notesHtml(shown, y.links, cutMark(shown, cut))}${photosHtml(y.photos)}${tagsHtml(y.tags)}${filesHtml}<p style="margin:2px 0 0;">${action(escape(pastLink(y.day)), cut ? 'Read the rest' : `See ${escape(String(then))}`)}</p>
</td></tr>
`;
}

export function pastDayHtml(v: Version, birthday: string, p: PastDay, limit: number): string {
  const then = computeVersion(birthday, p.day),
    skyHtml = p.sky
      ? `<p class="ink-2" style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:1.45;color:${INK_2};">${asciiHtml(p.sky)}</p>\n`
      : '',
    [shown, cut] = shownText(p, limit),
    notes = notesHtml(shown, p.links, cut ? '…' : '') + photosHtml(p.photos),
    tagHtml = tagsHtml(p.tags);
  return `<p class="ink-2" style="margin:32px 0 6px;${KICKER}">${escape(yearsAgo(v, then))} &middot; ${escape(longDate(p.day))}, ${Number(p.day.slice(0, 4))}</p>
<p style="margin:0 0 ${p.sky ? 8 : 12}px;">${vnumHtml(then, 26)}</p>
${skyHtml}${notes}${tagHtml}<p style="margin:2px 0 0;">${action(escape(pastLink(p.day)), escape(pastMore(cut, unshown(p.files, p.photos), String(then))))}</p>
`;
}

export function pastHtml(v: Version, birthday: string, past: OnThisDay): string {
  const days = past.shown.map((p) => pastDayHtml(v, birthday, p, budget(past))).join(''),
    more = past.more.length
      ? `<p class="ink-2" style="margin:24px 0 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK_2};">And ${past.more.length} more: ` +
        past.more
          .map(
            (d) => `<a class="link" href="${escape(pastLink(d))}" style="color:${BLUE};">${Number(d.slice(0, 4))}</a>`
          )
          .join(' &middot; ') +
        '</p>\n'
      : '';
  return `<tr><td style="padding:48px 0 0;">
<p class="ink" style="margin:0 0 6px;font-family:${FONT};font-size:22px;line-height:1.2;font-weight:800;color:${INK};">On this day</p>
<p class="ink-2" style="margin:0;font-family:${FONT};font-size:15px;line-height:1.45;color:${INK_2};">${escape(sectionLede(v, past))}</p>
${days}${more}</td></tr>
`;
}

export function productUpdateHtml(update: ProductUpdate): string {
  return `<tr><td style="padding:48px 0 0;">
<p class="ink-2" style="margin:0 0 8px;${KICKER}">${UPDATE_LABEL}</p>
<p class="ink" style="margin:0 0 12px;font-family:${FONT};font-size:22px;line-height:1.2;font-weight:800;color:${INK};">${asciiHtml(update.title)}</p>
${notesHtml(update.text, update.links)}</td></tr>\n`;
}
export function htmlBody(v: Version, birthday: string, day: string, o: BodyOptions = {}): string {
  const { streak, past, forecast, welcome, token, lifetime, yesterday, inbox, closed } = o,
    vs = escape(String(v)),
    party = birthdayLine(v),
    partyHtml = party
      ? `<p class="party" style="margin:16px 0 0;font-family:${FONT};font-size:20px;font-weight:800;color:${PINK_INK};">${escape(party)}</p>`
      : '',
    special = o.badges ? specialLine(v) : null,
    specialHtml = special
      ? `<p class="ink-2" id="special-day" style="margin:16px 0 0;font-family:${FONT};font-size:17px;line-height:1.45;color:${INK_2};">${escape(special)}</p>`
      : '',
    link = `${SITE}/birthday/?p=${birthday}`,
    inlineV = vs.replace(/\./g, `<span class="sep" style="color:${ORANGE_INK};">.</span>`),
    welcomeHtml = welcome
      ? `<tr><td class="ink" style="padding:0 0 32px;font-family:${FONT};font-size:17px;line-height:1.5;color:${INK};">${asciiHtml(welcome)}</td></tr>\n`
      : '',
    forecastHtml = forecast ? `<br><span class="ink-2" style="color:${INK_2};">${asciiHtml(forecast)}</span>` : '',
    meta = (href: string, label: string) =>
      `<a class="ink-2" href="${href}" style="color:${INK_2};text-decoration:underline;text-underline-offset:2px;">${label}</a>`,
    creditHtml = credited(forecast, past) ? ` &middot; ${meta(CREDIT_URL, CREDIT)}` : '',
    unsubscribeHtml = token ? ` &middot; ${meta(escape(unsubscribeLink(token)), 'Unsubscribe')}` : '',
    inboxHtml = inbox ? `<br>Write any day, no reply needed: ${meta(`mailto:${escape(inbox)}`, escape(inbox))}` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>You're ${vs} today</title>
<style>${DARK_CSS}</style>
</head>
<body class="paper" style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">Reply with anything about today, and it becomes the release notes for ${vs}.</div>
<table role="presentation" class="paper" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
<tr><td align="center" style="padding:40px 22px 48px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">

<tr><td class="ink-2" style="padding:0 0 40px;font-family:${FONT};font-size:14px;color:${INK_2};">
<strong class="ink" style="color:${INK};">Release Notes</strong> &middot; ${escape(longDate(day))}${forecastHtml}
</td></tr>

${welcomeHtml}<tr><td>
<p class="ink" style="margin:0 0 10px;font-family:${FONT};font-size:18px;color:${INK};">Today you&rsquo;re</p>
<div class="vnum-hero" role="heading" aria-level="1" aria-label="${vs}">${vnumHtml(v, 76)}</div>
${partyHtml}${specialHtml}
</td></tr>

<tr><td style="padding:36px 0 0;">
${yearDots(v)}
<p class="ink-2" style="margin:8px 0 0;font-family:${FONT};font-size:15px;line-height:1.45;color:${INK_2};">
<span class="ink" style="font-family:${MONO};font-weight:700;color:${INK};">${escape(nextRelease(v))}</span> ships ${escape(ships(v))}. <a class="link" href="${escape(link)}" style="color:${BLUE};font-weight:700;text-decoration:underline;">See your number</a>
<br>${lifeLine(v, birthday, '&mdash;')}
</p>
</td></tr>

${o.productUpdate ? productUpdateHtml(o.productUpdate) : ''}<tr><td style="padding:48px 0 0;">
<p class="ink" style="margin:0 0 12px;font-family:${FONT};font-size:28px;line-height:1.15;font-weight:800;letter-spacing:-0.01em;color:${INK};">Reply any time today.</p>
<p class="ink" style="margin:0 0 12px;font-family:${FONT};font-size:19px;line-height:1.5;color:${INK};">
What happened, what you made, who you saw. Whatever you send back becomes the release notes for
<span class="vnum" style="font-family:${MONO};font-weight:700;letter-spacing:-0.03em;color:${BLUE};white-space:nowrap;">${inlineV}</span>.
</p>
<p class="ink-2" style="margin:0;font-family:${FONT};font-size:15px;line-height:1.45;color:${INK_2};">Just hit reply. A line is plenty, and photos and voice memos work too. Reply as often as you like; it all adds up to today&rsquo;s notes.</p>
</td></tr>

${streakHtml(v, birthday, streak, lifetime, o.badges?.news)}
${upcomingHtml(o.upcoming)}${closed ? closedHtml(closed) : ''}${yesterday ? yesterdayHtml(birthday, yesterday) : ''}
${past ? pastHtml(v, birthday, past) : ''}
<tr><td class="ink-2" style="padding:48px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK_2};">
Release Notes, from ${meta(`${SITE}/`, 'Your Version Number')}. ${meta(`${APP}/settings/`, 'Pause or manage')}${unsubscribeHtml}${creditHtml}${inboxHtml}
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>
`;
}

// The account emails (sign-in, delete, late, notice) share one page: the
// daily email's header and dark mode, a headline, then the words.
export const ACCOUNT_CSS = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  body, .paper { background: #14163a !important; }
  .ink { color: #fffbf2 !important; }
  .ink-2 { color: #c9cbe6 !important; }
  .vnum, .link { color: #8fb0ff !important; }
}
`;
export const ACCOUNT_P = `margin:0 0 18px;font-family:${FONT};font-size:16px;line-height:1.55;color:${INK_2};`;
export const accountHtml = (title: string, heading: string, inner: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${title}</title><style>${ACCOUNT_CSS}</style></head>
<body class="paper" style="margin:0;padding:0;background:${PAPER};">
<table role="presentation" class="paper" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};"><tr><td align="center" style="padding:40px 22px 48px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;"><tr><td>
<p class="ink" style="margin:0 0 40px;font-family:${FONT};font-size:14px;font-weight:700;color:${INK};">Release Notes</p>
<p class="ink" style="margin:0 0 16px;font-family:${FONT};font-size:28px;line-height:1.15;font-weight:800;letter-spacing:-0.01em;color:${INK};">${heading}</p>
${inner}</td></tr></table>
</td></tr></table>
</body></html>
`;
export const codeHtml = (label: string, code: string) =>
  `<p class="ink-2" style="margin:0 0 6px;${KICKER}">${label}</p>
<p class="vnum" style="margin:0 0 24px;font-family:${MONO};font-size:30px;line-height:1;font-weight:700;letter-spacing:0.2em;color:${BLUE};">${escape(code)}</p>
`;
const inlineVersion = (version: string) =>
  `<span class="vnum" style="font-family:${MONO};font-weight:700;letter-spacing:-0.03em;color:${BLUE};white-space:nowrap;">${escape(version)}</span>`;

export function lateHtml(version: string, day: string): string {
  return accountHtml(
    `Too late for ${escape(version)}`,
    `Too late for ${inlineVersion(version)}`,
    `<p class="ink-2" style="${ACCOUNT_P}">Your reply came in too late to be added to the release notes for ${inlineVersion(version)}, ${escape(longDate(day))}, ${Number(day.slice(0, 4))}. A day&rsquo;s email takes replies for 72 hours. You can still add it on that day&rsquo;s page.</p>
<p style="margin:0;">${action(escape(pastLink(day)), 'Add it on the web', 18)}</p>
`
  );
}
const transport = nodemailer.createTransport({
  streamTransport: true,
  buffer: true,
  newline: 'unix',
  disableFileAccess: true,
  disableUrlAccess: true
});
export interface MessageOptions extends BodyOptions {
  to: string;
  fromAddr: string;
  token: string;
  inboundDomain: string;
  v: Version;
  birthday: string;
  day: string;
  images?: Record<string, Buffer>;
}
export async function buildMessage(o: MessageOptions): Promise<Buffer> {
  const standing = o.inbox ? standingAddress(o.inbox, o.inboundDomain) : null,
    parts = { ...o, inbox: standing };
  const result = await transport.sendMail({
    from: { name: 'Release Notes', address: o.fromAddr },
    to: o.to,
    replyTo: { name: 'Release Notes', address: replyAddress(o.token, o.inboundDomain) },
    subject: subject(o.v),
    messageId: `<${randomUUID()}@${o.fromAddr.split('@')[1]}>`,
    headers: {
      'List-Unsubscribe': `<${APP}/api/unsubscribe?t=${o.token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Auto-Response-Suppress': 'OOF, AutoReply'
    },
    text: body(o.v, o.birthday, parts),
    html: htmlBody(o.v, o.birthday, o.day, parts),
    attachments: Object.entries(o.images ?? {}).map(([cid, content]) => ({
      filename: cid.split('@')[0] + '.jpg',
      content,
      contentType: 'image/jpeg',
      contentDisposition: 'inline',
      cid
    })),
    disableFileAccess: true,
    disableUrlAccess: true
  });
  if (!Buffer.isBuffer(result.message)) throw new TypeError('Expected buffered MIME message');
  return result.message;
}
export function messageId(raw: unknown): string | null {
  const value = pythonTrim(String(raw ?? ''));
  return /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/.test(value) ? value : null;
}
export const lateText = (version: string, day: string) =>
  `Your reply came in too late to be added to the release notes for ${version},\n${longDate(day)}, ${Number(day.slice(0, 4))}. A day's email takes replies for 72 hours.\n\nYou can still add it on the web, on that day's page:\n\n${pastLink(day)}\n`;
export async function lateMessage(o: {
  to: string;
  fromAddr: string;
  version: string;
  day: string;
  inReplyTo: string | null;
}): Promise<Buffer> {
  const thread = messageId(o.inReplyTo);
  const result = await transport.sendMail({
    from: { name: 'Release Notes', address: o.fromAddr },
    to: o.to,
    subject: `Re: You're ${o.version} today`,
    messageId: `<${randomUUID()}@${o.fromAddr.split('@')[1]}>`,
    ...(thread ? { inReplyTo: thread, references: thread } : {}),
    headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
    text: lateText(o.version, o.day),
    html: lateHtml(o.version, o.day),
    disableFileAccess: true,
    disableUrlAccess: true
  });
  if (!Buffer.isBuffer(result.message)) throw new TypeError('Expected buffered MIME message');
  return result.message;
}
/** The mail log reasons that earn the owner a notice (workers/inbound.ts). */
export type NoticeReason = 'from-mismatch' | 'unauthenticated' | 'unparseable' | 'failed';
export interface NoticeOptions {
  to: string;
  fromAddr: string;
  reason: NoticeReason;
  received: string;
  tz: string;
  kept: boolean;
}
export function noticeLines(o: Omit<NoticeOptions, 'fromAddr'>): [string, string] {
  const when = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: o.tz
    }).format(new Date(o.received)),
    why = {
      'from-mismatch': `it came from another address. Release Notes takes email only from ${o.to}`,
      unauthenticated: `it couldn't be verified as coming from ${o.to}`,
      unparseable: "it couldn't be read",
      failed: "something went wrong while filing it, and three tries didn't fix it. The problem has been reported"
    }[o.reason],
    next =
      o.reason === 'from-mismatch'
        ? 'If you sent it, send it again from there, or add it on the web.'
        : o.kept
          ? 'Its words are kept in your activity log, ready to add on the web.'
          : 'If you sent it, add it on the web.';
  return [`An email to your Release Notes address on ${when} wasn't added to your notes, because ${why}.`, next];
}
export const noticeText = (o: Omit<NoticeOptions, 'fromAddr'>) =>
  noticeLines(o).join('\n\n') +
  `\n\nYour activity log shows what became of each email you send in:\n\n${APP}/activity/\n`;
const curly = (text: string) => escape(text).replace(/&#x27;/g, '&rsquo;');
export function noticeHtml(o: Omit<NoticeOptions, 'fromAddr'>): string {
  const [what, next] = noticeLines(o);
  return accountHtml(
    'Not added to your notes',
    'An email wasn&rsquo;t added to your notes',
    `<p class="ink-2" style="${ACCOUNT_P}">${curly(what)}</p>
<p class="ink-2" style="${ACCOUNT_P}">${curly(next)}</p>
<p style="margin:0;">${action(`${APP}/activity/`, 'See your activity log', 18)}</p>
`
  );
}
/** To the owner's own address, never the sender's. */
export async function noticeMessage(o: NoticeOptions): Promise<Buffer> {
  const result = await transport.sendMail({
    from: { name: 'Release Notes', address: o.fromAddr },
    to: o.to,
    subject: "An email wasn't added to your notes",
    messageId: `<${randomUUID()}@${o.fromAddr.split('@')[1]}>`,
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
    text: noticeText(o),
    html: noticeHtml(o),
    disableFileAccess: true,
    disableUrlAccess: true
  });
  if (!Buffer.isBuffer(result.message)) throw new TypeError('Expected buffered MIME message');
  return result.message;
}
