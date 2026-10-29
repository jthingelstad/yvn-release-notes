/** Badges (docs/BADGES.md): rewards for writing regularly, worked out from
 * facts already stored (dates, sources, files, places, weather, hashtags and
 * word counts), never from what a note says. Pure, like computeStreak.
 * Every badge is stamped with the version on the day it came true: notes are
 * replayed in the order they were written, so an import earns on the day it
 * was first written and a late note on the day it was filed in. Collectibles
 * carry the special version they were collected on. Tracks are earned at the
 * best run, never the current one, so a break takes nothing away; deleting
 * the note that earned a badge does. Nothing here names a miss.
 * Giving badges (domain/giving.ts) are the one shelf not worked out from
 * notes: one for each year a Weekly Thing lookup saw a Supporting Member,
 * stamped with the first day it did. This year's is still to find until
 * earned; an earlier year's, no longer given, never is.
 * Events (`BadgeEvent`, badgeEventsOf) are the firsts earned outside notes
 * (Jamie, 2026-10-29): a profile photo set, feedback sent, feedback marked
 * done, a book asked for, a note an agent edited, and the Roadmap track's
 * dates added to Upcoming. They come from the activity log, FEEDBACK# and
 * UPCOMING#, join the replay in time order, and are never taken away: a
 * photo removed or a date deleted keeps what it earned. */
import { addDays, daysBetween, localDay, validTimezone, type Day } from './dates.ts';
import { computeVersion, releaseName, releaseSpan } from './version.ts';
import { computeStreak } from './streak.ts';
import { fold } from './unicode.ts';
import { NONPROFITS, givingId, givingYearOf, type GivingYear } from './giving.ts';

export type Shelf = 'track' | 'first' | 'craft' | 'collectible' | 'giving';
export interface BadgeInfo {
  id: string;
  name: string;
  line: string;
  hint: string;
  shelf: Shelf;
  secret?: boolean;
}
const badge = (shelf: Shelf, id: string, name: string, line: string, hint: string, secret = false): BadgeInfo => ({
  id,
  name,
  line,
  hint,
  shelf,
  ...(secret ? { secret } : {})
});
export const LEVELS = ['alpha', 'beta', 'rc', 'stable', 'LTS'] as const;
export const TRACKS = [
  { id: 'delivery', name: 'Continuous delivery', at: [3, 7, 30, 100, 365] },
  { id: 'cadence', name: 'Cadence', at: [2, 4, 12, 26, 52] },
  { id: 'patches', name: 'Patches shipped', at: [10, 50, 100, 365, 1000] },
  { id: 'coverage', name: 'Coverage', at: [25, 50, 75, 90, 100] },
  // Dates added to Upcoming, all time (Jamie, 2026-10-29: "A series for how
  // many you add that progress through some milestones").
  { id: 'roadmap', name: 'Roadmap', at: [1, 5, 15, 40, 100] }
] as const;
export type TrackId = (typeof TRACKS)[number]['id'];
export const BADGES: readonly BadgeInfo[] = [
  badge('first', 'hello', 'Hello, world', 'Your first note.', 'Write your first note.'),
  badge('first', 'ack', 'ACK', 'Answered the morning email.', 'Reply to your morning email.'),
  badge('first', 'web', 'Web release', 'Wrote a note on the web.', 'Write a note here, on the web.'),
  badge(
    'first',
    'webhook',
    'Webhook',
    'Sent a note to your own address.',
    'Send a note to your own address. It’s in Settings.'
  ),
  badge(
    'first',
    'pair',
    'Pair programming',
    'A note added by an agent you connected.',
    'Connect an agent in Settings and ask it to add or edit a note.'
  ),
  badge(
    'first',
    'assets',
    'Release assets',
    'Added a photo.',
    'Add a photo to a note, here, by email or through an agent.'
  ),
  badge('first', 'audio', 'Audio changelog', 'Added a voice memo.', 'Record a voice memo, or send one by email.'),
  badge('first', 'geotagged', 'Geotagged', 'Said where a note was.', 'Say where a note was, or send a photo.'),
  badge('first', 'tag', 'git tag', 'Used a hashtag.', 'Add a #hashtag to a note.'),
  badge('first', 'dependencies', 'Dependencies', 'Put a link in a note.', 'Put a link in a note.'),
  badge(
    'first',
    'commit',
    'Commit message',
    'A note of twenty words or fewer. Small commits ship.',
    'Write a note of twenty words or fewer.'
  ),
  badge('first', 'hotfix', 'Hotfix', 'Filled in a day after it ended.', 'Fill in a past day that has no note.'),
  badge(
    'first',
    'backport',
    'Backport',
    'Wrote about a day at least a month back.',
    'Write about a day at least 30 days back.'
  ),
  // The firsts earned outside notes (BadgeEvent).
  badge('first', 'signed', 'Signed commit', 'Added a profile photo.', 'Add a profile photo in Settings.'),
  badge(
    'first',
    'issue',
    'Issue opened',
    'Sent feedback.',
    'Send Jamie feedback from the You tab, or ask a connected agent to.'
  ),
  badge(
    'first',
    'merged',
    'Merged upstream',
    'Feedback you sent was marked done.',
    'Send feedback that gets built or fixed.'
  ),
  badge(
    'first',
    'tarball',
    'Tarball',
    'Made a book of your notes.',
    'Make a book of your notes, from the Archive or a release’s page.'
  ),
  badge(
    'craft',
    'fullstack',
    'Full stack',
    'Words, a photo and a voice memo on one day.',
    'Words, a photo and a voice memo on one day.'
  ),
  badge('craft', 'rfc', 'RFC', 'More than 1,000 words in one day.', 'Write more than 1,000 words in one day.'),
  badge('craft', 'taxonomy', 'Taxonomy', 'Ten different hashtags.', 'Use ten different hashtags.'),
  badge(
    'craft',
    'multiregion',
    'Multi-region',
    'Notes from five different cities.',
    'Write from five different cities, home included.'
  ),
  badge('craft', 'i18n', 'i18n', 'A note from another country.', 'Write from a country other than home.'),
  badge(
    'craft',
    'cold',
    'Cold start',
    'A note on a day that stayed below freezing.',
    'Write on a day that stays below freezing.'
  ),
  badge(
    'craft',
    'hot',
    'Hot reload',
    'A note on a day that reached 32 °C (90 °F).',
    'Write on a day that reaches 32 °C (90 °F).'
  ),
  badge(
    'craft',
    'allweather',
    'All-weather build',
    'Notes on a day of rain, a day of snow and a clear day.',
    'Write on a day of rain, a day of snow and a clear day.'
  ),
  badge('collectible', 'release-day', 'Release day', 'A note on your birthday.', 'Write on your birthday, x.y.0.'),
  badge(
    'collectible',
    'code-freeze',
    'Code freeze',
    'A note on the last patch before a birthday.',
    'Write on the last patch before your birthday.'
  ),
  badge('collectible', 'round', 'Round number', 'A note on a hundredth patch.', 'Write on patch 100, 200 or 300.'),
  badge(
    'collectible',
    'palindrome',
    'Palindrome',
    'A version that reads the same both ways.',
    'Write on a version that reads the same both ways, like 5.4.45.'
  ),
  badge(
    'collectible',
    'compatible',
    'Backward compatible',
    'The same patch in two releases in a row.',
    'Write on a patch you wrote on one release ago.'
  ),
  badge('collectible', 'history', 'Version history', 'Notes in five different releases.', 'Write in five releases.'),
  badge('collectible', 'dont-panic', 'Don’t panic', 'Patch 42.', 'The answer.', true),
  badge('collectible', 'overflow', 'Overflow', 'Patch 256. A byte can’t hold it.', 'A byte can’t hold it.', true),
  badge('collectible', 'pi', 'Pi', 'Patch 314.', 'Irrational.', true),
  badge(
    'collectible',
    'leap',
    'Leap patch',
    'Patch 365, in a release with a February 29.',
    'Not every release has one.',
    true
  ),
  badge('collectible', 'straight', 'Straight', 'Digits that count up by one.', '1, 2, 3…', true),
  badge('collectible', 'major', 'Major release', 'A note on x.0.0. Once a decade.', 'Write on x.0.0. Once a decade.')
];
const INFO = new Map(BADGES.map((b) => [b.id, b]));
const ORDER = new Map(BADGES.map((b, i) => [b.id, i]));
/** A giving year's badge, once its nonprofit is known. */
export function givingBadge(year: number): BadgeInfo | null {
  const n = NONPROFITS[year];
  if (!n) return null;
  return badge(
    'giving',
    givingId(year),
    `Supported ${n.short}`,
    `A Weekly Thing Supporting Member in ${year}, the year membership went to ${n.full}.`,
    `Be a Weekly Thing Supporting Member in ${year}: membership goes 100% to ${n.full} this year.`
  );
}
const infoOf = (id: string) => {
  const year = givingYearOf(id);
  return INFO.get(id) ?? (year === null ? null : givingBadge(year));
};

/** One note, as the evaluator needs it. `written` is the local day it was
 * written; `reply` marks an email answering a daily email (the standing
 * address's have no subject); `city` is the place's or else home's. */
export interface BadgeNote {
  day: Day;
  written: Day;
  at: string;
  source: string;
  reply: boolean;
  assistant: boolean;
  words: number;
  tags: readonly string[];
  links: number;
  photos: number;
  audio: number;
  placed: boolean;
  city?: string;
  country?: string;
}
export interface BadgeFacts {
  birthday: Day;
  homeCountry?: string;
  notes: readonly BadgeNote[];
  weather: Readonly<Record<Day, { high_c?: unknown; code?: unknown }>>;
  paused: ReadonlySet<Day>;
  /** The profile's giving years (domain/giving.ts). */
  giving?: readonly GivingYear[];
  /** What happened outside notes that earns a badge (badgeEventsOf). */
  events?: readonly BadgeEvent[];
}
/** Something done outside notes that earns a badge: `day` is the local day
 * it happened and `at` its time, which orders it among notes that day. `key`
 * names what it came from (an activity row's key, a feedback item or answer,
 * an Upcoming entry), so a save can leave its own out to see what it earned;
 * the Roadmap counts `upcoming` events by key, once each. */
export type BadgeEventKind = 'signed' | 'issue' | 'merged' | 'tarball' | 'pair' | 'upcoming';
export interface BadgeEvent {
  kind: BadgeEventKind;
  day: Day;
  at: string;
  key: string;
}
/** The badge each kind earns; `upcoming` counts toward the Roadmap. */
const EVENT_BADGE: Record<Exclude<BadgeEventKind, 'upcoming'>, string> = {
  signed: 'signed',
  issue: 'issue',
  merged: 'merged',
  tarball: 'tarball',
  pair: 'pair'
};
/** The badges events earn or help earn (Pair programming comes from notes
 * too). */
export const EVENT_BADGES: ReadonlySet<string> = new Set([...Object.values(EVENT_BADGE), 'roadmap']);
export interface EventSources {
  /** Activity rows (sk, kind, at, via, upcoming). */
  activity?: readonly Record<string, unknown>[];
  /** FEEDBACK# items: filed, and each answer's status. */
  feedback?: readonly { id: string; filed_at: string; answers: readonly { at: string; status: string }[] }[];
  /** UPCOMING# entries now saved. */
  upcoming?: readonly { id: string; created_at?: unknown }[];
  /** PROFILE.photo.at, for a photo whose photo.set row was never written. */
  photoAt?: unknown;
}
/** The events in a person's stored rows, each time made the local day in
 * `zone`: Signed commit from photo.set (else the photo's own time), Issue
 * opened from each item filed, Merged upstream from each answer that set
 * `done`, Tarball from export.book, Pair programming from a note.edited by
 * an agent, and one Roadmap event per Upcoming entry ever added, the union
 * by id of upcoming.added rows (from 2026-10-21) and the entries saved now,
 * each at its earliest known time. A date deleted keeps its row, so the
 * count never falls. */
export function badgeEventsOf(src: EventSources, zone: string): BadgeEvent[] {
  const tz = validTimezone(zone) ? zone : 'UTC',
    out: BadgeEvent[] = [],
    dayOf = (at: unknown): Day | null => {
      const epoch = typeof at === 'string' ? Date.parse(at) : NaN;
      return Number.isFinite(epoch) ? localDay(Math.floor(epoch / 1000), tz) : null;
    },
    add = (kind: BadgeEventKind, at: unknown, key: string) => {
      const day = dayOf(at);
      if (day) out.push({ kind, day, at: String(at), key });
    },
    added = new Map<string, string>(),
    earliest = (id: string, at: unknown) => {
      if (typeof at === 'string' && dayOf(at) && (!added.has(id) || Date.parse(at) < Date.parse(added.get(id)!)))
        added.set(id, at);
    };
  let photoRow = false;
  for (const row of src.activity ?? []) {
    const kind = row.kind,
      key = String(row.sk);
    if (kind === 'photo.set') {
      photoRow = true;
      add('signed', row.at, key);
    } else if (kind === 'export.book') add('tarball', row.at, key);
    else if (kind === 'note.edited' && row.via === 'assistant') add('pair', row.at, key);
    else if (kind === 'upcoming.added' && typeof row.upcoming === 'string') earliest(row.upcoming, row.at);
  }
  if (!photoRow && src.photoAt) add('signed', src.photoAt, 'photo');
  for (const f of src.feedback ?? []) {
    add('issue', f.filed_at, `feedback:${f.id}`);
    f.answers.forEach((a, i) => {
      if (a.status === 'done') add('merged', a.at, `feedback:${f.id}:${i}`);
    });
  }
  for (const e of src.upcoming ?? []) earliest(e.id, e.created_at);
  for (const [id, at] of added) add('upcoming', at, upcomingEventKey(id));
  return out;
}
export const upcomingEventKey = (id: string) => `upcoming:${id}`;
export interface Earned {
  key: string;
  id: string;
  level?: string;
  name: string;
  line: string;
  shelf: Shelf;
  /** The day it came true, and the version it is stamped with: that day's,
   * or for a collectible the special day's. */
  earned: Day;
  day: Day;
  version: string;
}
export interface Track {
  id: TrackId;
  name: string;
  tier: number;
  level: string | null;
  best: number;
  now: number;
  since: { day: Day; version: string } | null;
  next: { level: string; at: number } | null;
  release?: string;
}
export interface AlbumDay {
  day: Day;
  version: string;
  ids: string[];
  names: string[];
}
export interface SpecialDay {
  day: Day;
  version: string;
  kinds: string[];
}
export interface ReleaseAlbum {
  v: string;
  from: Day;
  through: Day;
  cycle: number;
  days: number;
  percent: number;
  level: string | null;
  next: { level: string; at: number; more: number } | null;
  following: { v: string; date: Day };
  collected: AlbumDay[];
  ahead: AlbumDay[];
}
export interface Missing {
  id?: string;
  name?: string;
  hint: string;
  shelf: Shelf;
  secret?: boolean;
}
export interface Badges {
  count: number;
  earned: Earned[];
  tracks: Track[];
  release: ReleaseAlbum;
  missing: Missing[];
}
/** Something a save just earned: a badge, or (`album`) a special day of this
 * release collected again, its badge earned in an earlier one. */
export interface Unlocked {
  key: string;
  id: string;
  name: string;
  version: string;
  album?: true;
}

/** The special days a version is: kind ids in catalog order. */
export function specialKinds(major: number, minor: number, patch: number, cycle: number): string[] {
  const digits = `${major}${minor}${patch}`,
    kinds = new Set<string>();
  if (patch === 0) kinds.add('release-day');
  if (patch === cycle - 1) kinds.add('code-freeze');
  if (patch === 100 || patch === 200 || patch === 300) kinds.add('round');
  if (digits === [...digits].reverse().join('')) kinds.add('palindrome');
  if (patch === 42) kinds.add('dont-panic');
  if (patch === 256) kinds.add('overflow');
  if (patch === 314) kinds.add('pi');
  if (patch === 365) kinds.add('leap');
  if ([...digits].every((c, i) => !i || Number(c) === Number(digits[i - 1]) + 1)) kinds.add('straight');
  if (patch === 0 && minor === 0) kinds.add('major');
  return [...kinds].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
}
/** A release's special days, in order, each with every kind it is. */
export function album(birthday: Day, age: number): SpecialDay[] {
  const [first] = releaseSpan(birthday, age),
    v = computeVersion(birthday, first),
    out: SpecialDay[] = [];
  for (let patch = 0; patch < v.cycleDays; patch++) {
    const kinds = specialKinds(v.major, v.minor, patch, v.cycleDays);
    if (kinds.length) out.push({ day: addDays(first, patch), version: `${v.major}.${v.minor}.${patch}`, kinds });
  }
  return out;
}

const RAIN = (c: number) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
const SNOW = (c: number) => (c >= 71 && c <= 77) || c === 85 || c === 86;
const CLEAR = (c: number) => c === 0 || c === 1;
const MONDAY = '2001-01-01';
const weekOf = (day: Day) => Math.floor(daysBetween(MONDAY, day) / 7);
/** The Sunday that ends `day`'s week: pauses are read through it, so a pause
 * already set for later this week lowers this week's cadence bar today. */
export const weekEnd = (day: Day) => addDays(day, 6 - (daysBetween(MONDAY, day) - weekOf(day) * 7));
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Runs of neighbours (days in a row, steady weeks in a row), merged as
 * members arrive in any order. */
class Runs<K> {
  private up = new Map<K, K>();
  private size = new Map<K, number>();
  best = 0;
  has(k: K) {
    return this.up.has(k);
  }
  private root(k: K): K {
    let r = k;
    while (this.up.get(r) !== r) r = this.up.get(r)!;
    while (k !== r) {
      const next = this.up.get(k)!;
      this.up.set(k, r);
      k = next;
    }
    return r;
  }
  add(k: K, neighbours: readonly (K | null)[]) {
    this.up.set(k, k);
    this.size.set(k, 1);
    for (const n of neighbours) {
      if (n === null) continue;
      const a = this.root(k),
        b = this.root(n);
      if (a !== b) {
        this.up.set(b, a);
        this.size.set(a, this.size.get(a)! + this.size.get(b)!);
      }
    }
    this.best = Math.max(this.best, this.size.get(this.root(k))!);
  }
}

export function evaluateBadges(facts: BadgeFacts, today: Day): Badges {
  const birthday = facts.birthday,
    stamp = (day: Day) => String(computeVersion(birthday, day)),
    earned = new Map<string, Earned>(),
    order: string[] = [];
  const give = (id: string, when: Day, day: Day = when, level?: string) => {
    const key = level ? `${id}:${level.toLowerCase()}` : id;
    if (earned.has(key)) return;
    const track = TRACKS.find((t) => t.id === id),
      info = infoOf(id);
    earned.set(key, {
      key,
      id,
      ...(level ? { level } : {}),
      name: track ? `${track.name} ${level}` : info!.name,
      line: track ? trackLine(id as TrackId, track.at[LEVELS.indexOf(level as never)]!) : info!.line,
      shelf: track ? 'track' : info!.shelf,
      earned: when,
      day,
      version: stamp(day)
    });
    order.push(key);
  };

  // Replay in writing order. A note counts from the day it was written, never
  // before the day it is about, and never after today.
  const when = (n: BadgeNote) => {
    const day = n.written > n.day ? n.written : n.day;
    return day > today ? today : day;
  };
  const notes = facts.notes
    .filter((n) => n.day >= birthday && n.day <= today)
    .map((n) => ({ n, w: when(n) }))
    .sort((a, b) => cmp(a.w, b.w) || cmp(a.n.at, b.n.at) || cmp(a.n.day, b.n.day));

  const have = new Set<Day>(),
    days = new Runs<Day>(),
    weeks = new Runs<number>(),
    weekDays = new Map<number, number>(),
    pausedIn = new Map<number, number>(),
    releaseDays = new Map<number, number>(),
    perDay = new Map<Day, { words: number; photos: number; audio: number }>(),
    tags = new Set<string>(),
    cities = new Set<string>(),
    skies = new Set<string>(),
    ages = new Set<number>();
  for (const d of facts.paused) pausedIn.set(weekOf(d), (pausedIn.get(weekOf(d)) ?? 0) + 1);
  const bar = (week: number) => Math.min(4, 7 - (pausedIn.get(week) ?? 0));
  const skipDay = (d: Day) => facts.paused.has(d) && !have.has(d);
  const dayNeighbour = (d: Day, step: 1 | -1) => {
    let x = addDays(d, step);
    while (skipDay(x)) x = addDays(x, step);
    return have.has(x) ? x : null;
  };
  const weekNeighbour = (w: number, step: 1 | -1) => {
    let x = w + step;
    while (bar(x) <= 0) x += step;
    return weeks.has(x) ? x : null;
  };
  const home = facts.homeCountry ? fold(facts.homeCountry) : '';

  // Giving years join the replay on the first day each was seen, and events
  // (badgeEventsOf) on the day they happened, in time order among that day's
  // notes. Never before the birthday, never after today.
  const roadmap = new Set<string>(),
    timed: { day: Day; at: string; run: () => void }[] = [
      ...(facts.giving ?? [])
        .filter((g) => givingBadge(g.year) && g.first >= birthday && g.first <= today)
        .map((g) => ({ day: g.first, at: '', run: () => give(givingId(g.year), g.first) })),
      ...(facts.events ?? [])
        .filter((e) => e.day >= birthday)
        .map((e) => {
          const day = e.day > today ? today : e.day;
          return {
            day,
            at: e.at,
            run: () => {
              if (e.kind !== 'upcoming') return give(EVENT_BADGE[e.kind], day);
              roadmap.add(e.key);
              tiers('roadmap', roadmap.size, day);
            }
          };
        })
    ].sort((a, b) => cmp(a.day, b.day) || cmp(a.at, b.at));
  let ran = 0;
  const giveUpTo = (day: Day, at?: string) => {
    for (
      ;
      ran < timed.length &&
      (timed[ran]!.day < day || (timed[ran]!.day === day && (at === undefined || timed[ran]!.at <= at)));
      ran++
    )
      timed[ran]!.run();
  };

  for (const { n, w } of notes) {
    giveUpTo(w, n.at);
    const fresh = !have.has(n.day);
    give('hello', w);
    if (n.source === 'email' && n.reply) give('ack', w);
    if (n.source === 'email' && !n.reply) give('webhook', w);
    if (n.source === 'web') give('web', w);
    if (n.assistant) give('pair', w);
    if (n.photos) give('assets', w);
    if (n.audio) give('audio', w);
    if (n.placed) give('geotagged', w);
    if (n.tags.length) give('tag', w);
    if (n.links) give('dependencies', w);
    if (n.words >= 1 && n.words <= 20) give('commit', w);
    if (n.source !== 'import' && fresh && w > n.day) give('hotfix', w);
    if (n.source !== 'import' && daysBetween(n.day, w) >= 30) give('backport', w);

    const sum = perDay.get(n.day) ?? { words: 0, photos: 0, audio: 0 };
    sum.words += n.words;
    sum.photos += n.photos;
    sum.audio += n.audio;
    perDay.set(n.day, sum);
    if (sum.words && sum.photos && sum.audio) give('fullstack', w);
    if (sum.words > 1000) give('rfc', w);
    for (const t of n.tags) tags.add(t);
    if (tags.size >= 10) give('taxonomy', w);
    if (n.city) cities.add(fold(`${n.city}|${n.country ?? ''}`));
    if (cities.size >= 5) give('multiregion', w);
    if (home && n.country && fold(n.country) !== home) give('i18n', w);
    const sky = facts.weather[n.day],
      high = number(sky?.high_c),
      code = number(sky?.code);
    if (high !== null && high < 0) give('cold', w);
    if (high !== null && high >= 32) give('hot', w);
    if (code !== null) {
      if (RAIN(code)) skies.add('rain');
      if (SNOW(code)) skies.add('snow');
      if (CLEAR(code)) skies.add('clear');
    }
    if (skies.size === 3) give('allweather', w);

    if (!fresh) continue;
    // A day's first note: the runs, the counts and the special days.
    const left = dayNeighbour(n.day, -1),
      right = dayNeighbour(n.day, 1);
    have.add(n.day);
    days.add(n.day, [left, right]);
    const week = weekOf(n.day),
      inWeek = (weekDays.get(week) ?? 0) + 1;
    weekDays.set(week, inWeek);
    if (!weeks.has(week) && bar(week) > 0 && inWeek >= bar(week))
      weeks.add(week, [weekNeighbour(week, -1), weekNeighbour(week, 1)]);
    const v = computeVersion(birthday, n.day),
      inRelease = (releaseDays.get(v.age) ?? 0) + 1;
    releaseDays.set(v.age, inRelease);
    ages.add(v.age);
    tiers('delivery', days.best, w);
    tiers('cadence', weeks.best, w);
    tiers('patches', have.size, w);
    TRACKS[3].at.forEach((t, i) => {
      if (inRelease >= needed(t, v.cycleDays)) give('coverage', w, w, LEVELS[i]);
    });
    if (ages.size >= 5) give('history', w);
    for (const kind of specialKinds(v.major, v.minor, v.patch, v.cycleDays)) give(kind, w, n.day);
    for (const other of [v.age - 1, v.age + 1]) {
      if (other < 0) continue;
      const [first, last] = releaseSpan(birthday, other),
        twin = addDays(first, v.patch);
      if (twin <= last && have.has(twin)) give('compatible', w, twin > n.day ? twin : n.day);
    }
  }
  giveUpTo(today);
  function tiers(id: TrackId, value: number, w: Day) {
    TRACKS.find((t) => t.id === id)!.at.forEach((t, i) => {
      if (value >= t) give(id, w, w, LEVELS[i]);
    });
  }

  // Where things stand today.
  const v = computeVersion(birthday, today),
    [from, through] = releaseSpan(birthday, v.age),
    streak = computeStreak(have, have.has(today) ? addDays(today, 1) : today, facts.paused);
  let week = weekOf(today),
    cadence = weeks.has(week) ? 1 : 0;
  for (week--; weeks.has(week) || bar(week) <= 0; week--) if (weeks.has(week)) cadence++;
  let bestAge = v.age,
    bestShare = 0;
  for (const [age, n] of releaseDays) {
    const share = n / computeVersion(birthday, releaseSpan(birthday, age)[0]).cycleDays;
    if (share > bestShare) [bestAge, bestShare] = [age, share];
  }
  const percent = (age: number) =>
    Math.floor(((releaseDays.get(age) ?? 0) * 100) / computeVersion(birthday, releaseSpan(birthday, age)[0]).cycleDays);
  const track = (id: TrackId, best: number, now: number): Track => {
    const t = TRACKS.find((x) => x.id === id)!,
      tier = t.at.filter((at) => best >= at).length,
      got = tier ? earned.get(`${id}:${LEVELS[tier - 1]!.toLowerCase()}`)! : null;
    return {
      id,
      name: t.name,
      tier,
      level: tier ? LEVELS[tier - 1]! : null,
      best,
      now,
      since: got ? { day: got.day, version: got.version } : null,
      next: tier < 5 ? { level: LEVELS[tier]!, at: t.at[tier]! } : null
    };
  };
  const tracks = [
    track('delivery', days.best, streak.current),
    track('cadence', weeks.best, cadence),
    track('patches', have.size, have.size),
    { ...track('coverage', percent(bestAge), percent(v.age)), release: releaseName(bestAge) },
    track('roadmap', roadmap.size, roadmap.size)
  ];

  // This release: coverage so far, its special days collected, and the next
  // few ahead (never a secret one, never one that went by without a note).
  const inRelease = releaseDays.get(v.age) ?? 0,
    left = daysBetween(today, through) + (have.has(today) ? 0 : 1),
    reached = TRACKS[3].at.filter((t) => inRelease >= needed(t, v.cycleDays)).length,
    target = reached < 5 ? needed(TRACKS[3].at[reached]!, v.cycleDays) : 0;
  const named = (d: SpecialDay, all: boolean): AlbumDay => {
    const ids = d.kinds.filter((k) => all || !INFO.get(k)!.secret);
    return { day: d.day, version: d.version, ids, names: ids.map((k) => INFO.get(k)!.name) };
  };
  const ahead = [...album(birthday, v.age), ...album(birthday, v.age + 1)]
    .filter((d) => d.day >= today && !have.has(d.day))
    .map((d) => named(d, false))
    .filter((d) => d.names.length)
    .slice(0, 3);
  const release: ReleaseAlbum = {
    v: releaseName(v.age),
    from,
    through,
    cycle: v.cycleDays,
    days: inRelease,
    percent: percent(v.age),
    level: reached ? LEVELS[reached - 1]! : null,
    next:
      reached < 5 && target - inRelease <= left
        ? { level: LEVELS[reached]!, at: target, more: target - inRelease }
        : null,
    following: { v: releaseName(v.age + 1), date: addDays(through, 1) },
    collected: album(birthday, v.age)
      .filter((d) => d.day <= today && have.has(d.day))
      .map((d) => named(d, true)),
    ahead
  };

  const list = order.map((k) => earned.get(k)!).reverse(),
    // This calendar year's giving badge is still to find until earned (Jamie,
    // 2026-10-25: "We should be encouraging people to be a supporting
    // member"). An earlier year can no longer be given, so is never listed.
    givingNow = givingBadge(Number(today.slice(0, 4)));
  return {
    count: list.length,
    earned: list,
    tracks,
    release,
    missing: [
      ...BADGES.filter((b) => !earned.has(b.id)).map((b) =>
        b.secret
          ? { hint: b.hint, shelf: b.shelf, secret: true }
          : { id: b.id, name: b.name, hint: b.hint, shelf: b.shelf }
      ),
      ...(givingNow && !earned.has(givingNow.id)
        ? [{ id: givingNow.id, name: givingNow.name, hint: givingNow.hint, shelf: givingNow.shelf }]
        : [])
    ]
  };
}

/** What is earned and not yet told (`seen`), for the morning email's line
 * and the web's welcome back: oldest first, a track's tiers earned since as
 * the highest alone, and `keys`, every one of them to mark seen once told. */
export function untold(b: Badges, seen: ReadonlySet<string>): { news: Earned[]; keys: string[] } {
  const fresh = b.earned.filter((e) => !seen.has(e.key)).reverse(),
    top = new Map<string, number>();
  fresh.forEach((e, i) => top.set(e.id, i));
  return { news: fresh.filter((e, i) => top.get(e.id) === i), keys: fresh.map((e) => e.key) };
}

/** What a save earned: what `after` (with the new note) has that `before`
 * (without it) did not, in the order it came true, then this release's
 * special days it collected for badges earned before. */
export function unlocked(before: Badges, after: Badges): Unlocked[] {
  const had = new Set(before.earned.map((e) => e.key)),
    out: Unlocked[] = after.earned
      .filter((e) => !had.has(e.key))
      .reverse()
      .map((e) => ({ key: e.key, id: e.id, name: e.name, version: e.version })),
    told = new Set(out.map((u) => u.id)),
    collected = new Set(before.release.collected.map((d) => d.day));
  for (const d of after.release.collected)
    if (!collected.has(d.day))
      d.ids.forEach((id, i) => {
        if (!told.has(id)) out.push({ key: `${id}@${d.day}`, id, name: d.names[i]!, version: d.version, album: true });
      });
  return out;
}

/** The special days a day with notes collected, by name (a Day page's
 * "Collected here"). */
export function collectedOn(birthday: Day, day: Day): string[] {
  const v = computeVersion(birthday, day);
  return specialKinds(v.major, v.minor, v.patch, v.cycleDays).map((k) => INFO.get(k)!.name);
}

/** One release's badges, for its page head: the coverage tier its days with
 * notes reached, and the special days collected, by kind, with how many. */
export function releaseBadges(
  birthday: Day,
  age: number,
  have: ReadonlySet<Day>
): { coverage: string | null; collected: { id: string; name: string; count: number }[] } {
  const [first, last] = releaseSpan(birthday, age),
    cycle = computeVersion(birthday, first).cycleDays;
  let days = 0;
  for (const d of have) if (d >= first && d <= last) days++;
  const reached = TRACKS[3].at.filter((t) => days >= needed(t, cycle)).length,
    counts = new Map<string, number>();
  for (const d of album(birthday, age))
    if (have.has(d.day)) for (const k of d.kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  return {
    coverage: reached ? LEVELS[reached - 1]! : null,
    collected: [...counts]
      .sort(([a], [b]) => ORDER.get(a)! - ORDER.get(b)!)
      .map(([id, count]) => ({ id, name: INFO.get(id)!.name, count }))
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Days with notes a release of `cycle` days needs for a share. */
const needed = (percent: number, cycle: number) => Math.ceil((percent * cycle) / 100);
function trackLine(id: TrackId, at: number): string {
  if (id === 'delivery') return `${at} days in a row with a note.`;
  if (id === 'cadence') return `${at} weeks in a row with notes on four days or more.`;
  if (id === 'patches') return `${at.toLocaleString('en-US')} days with notes.`;
  if (id === 'roadmap') return at === 1 ? 'Added a date to Upcoming.' : `${at} dates added to Upcoming.`;
  return `Notes on ${at}% of one release’s days.`;
}
