// What the API answers (server/app/), as the pages read it.
import type { Badges as Shelf, Unlocked } from '../../../packages/domain/badges.ts';

// A note's text as shown: plain strings, links by name (links.segments) and
// hashtags (tags.split).
export type Part = string | { url: string; label?: string; site?: string } | { tag: string; text: string };

export interface Media {
  n: number;
  kind: 'image' | 'audio' | 'file';
  type: string;
  name?: string;
  // A link signed for this subscriber, good for ten minutes at least.
  url?: string;
  // A photo's small copy (thumbs.py), signed the same way: what the lists
  // show; `url` is the original, opened on a tap.
  thumb?: string;
  transcript?: string;
  description?: string;
  writing?: boolean;
}

export interface Note {
  id: string;
  source: 'email' | 'web' | 'import' | 'agent';
  author?: 'user' | 'assistant';
  client?: string | null;
  connection?: string;
  on_behalf_of?: string;
  text: string;
  parts?: Part[];
  at?: string;
  tz?: string;
  tags?: string[];
  place?: string;
  // Set when the note has no place of its own and shows the day's city or
  // home's instead; never mapped.
  place_from?: 'day' | 'home';
  map?: string;
  from?: string;
  edited_at?: string;
  media?: Media[];
  attachments?: number;
  late?: boolean;
}

export interface Day {
  date: string;
  version: string;
  notes: Note[];
  weather?: string;
  // the day's own place, by name, when set
  where?: string;
  paused?: boolean;
}

export interface Streak {
  current: number;
  longest: number;
  today: boolean;
}

export interface Today extends Day {
  tz: string;
  dots: number;
  next: { version: string; date: string };
  streak: Streak;
  paused_through?: string;
}

export interface DayPage extends Day {
  tz: string;
  // The special days it collected, when it has notes.
  collected?: string[];
}

export interface DaysPage {
  today: string;
  tz: string;
  days: Day[];
  before?: string | null;
}

export interface Me {
  admin?: boolean;
  new: boolean;
  email: string;
  birthday: string;
  tz: string;
  send_time: string;
  status: 'active' | 'stopped';
  stopped_reason?: 'unsubscribed' | 'bounce' | 'complaint';
  transcribe: boolean;
  describe: boolean;
  // "Show badges" (docs/BADGES.md), on unless turned off
  badges: boolean;
  // "Add where I am": a note saved on Today with no place gets Here's
  here: boolean;
  today: string;
  version: string;
  city?: string;
  region?: string;
  country?: string;
  pause?: { from: string; through: string };
  pause_starts: string;
  // the standing address, for a note by email any day (inbound.py)
  inbox?: string;
  // On the Weekly Thing's list (packages/backend/weekly-thing.ts); absent
  // until it has been looked up, or when it couldn't be
  weekly_thing?: WeeklyThing;
}

// member: a Supporting Member. reader: subscribed. unconfirmed: subscribed,
// not yet confirmed. none: not on the list.
export type WeeklyThing = 'member' | 'reader' | 'unconfirmed' | 'none';

export interface Sample {
  version: string;
  age: string;
  next: { version: string; date: string; days: number };
}

// A city from the search, or a device's spot (`from: 'device'`, "Here"),
// named at the city and kept exact for a note.
export interface Place {
  name: string;
  region?: string;
  country?: string;
  tz?: string;
  lat?: number;
  lon?: number;
  accuracy_m?: number;
  from?: 'device';
  // Here's: the neighbourhood, the business picked, and what was near.
  district?: string;
  venue?: string;
  nearby?: Venue[];
}
export interface Venue {
  name: string;
  lat: number;
  lon: number;
  distance_m: number;
}

// A release is a year of life ("4.5"), birthday to birthday.
export interface ReleaseSummary {
  v: string;
  from: string;
  through: string;
  days: number;
  notes: number;
  current?: boolean;
}

export interface Releases {
  today: string;
  releases: ReleaseSummary[];
}

// One release's days with notes, oldest first, a page at a time (`after`),
// under a head that sums up all of it.
export interface ReleasePage {
  v: string;
  current: boolean;
  from: string;
  through: string;
  today: string;
  tz: string;
  days_with_notes: number;
  notes: number;
  longest: number;
  // absent with badges turned off
  badges?: { coverage: string | null; collected: { id: string; name: string; count: number }[] };
  // the nonprofits given to as a Supporting Member while it ran
  giving?: string[];
  tags: { tag: string; notes: number }[];
  days: Day[];
  after?: string | null;
}

export interface TaggedDays {
  today: string;
  tz: string;
  tag: string;
  days: Day[];
}

export interface SearchResult {
  today: string;
  tz: string;
  terms: string[];
  notes: number;
  day_count: number;
  days: Day[];
}

export interface ZipStatus {
  status: 'none' | 'building' | 'ready' | 'failed';
  until?: string;
  size?: number;
  files?: number;
}

// GET /api/book: the book this account is making or made, offered for a
// day. `reason: 'empty'` is a book whose days had no notes by the time it
// was made.
export interface BookStatus {
  today: string;
  status: 'none' | 'building' | 'ready' | 'failed';
  from?: string;
  to?: string;
  page?: '6x9' | 'letter';
  title?: string;
  // The book asked for Claude's commentary.
  annotated?: true;
  reason?: 'empty' | 'commentary';
  // What a Supporting Member may still add; absent for anyone else.
  commentary?: { left: number; max: number; release: string; max_days: number };
  size?: number;
  pages?: number;
  photos?: number;
  missing?: number;
  built_at?: string;
  until?: string;
}

// GET /api/book/plan: what a span of days holds, and the title a book of it
// gets unless one is typed.
export interface BookPlan {
  from: string;
  to: string;
  title: string;
  days: number;
  notes: number;
  photos: number;
  memos: number;
  max_photos: number;
}

// GET /api/activity: the account's activity log, newest first, a page at a
// time; `next` is the `before` of the page after, or null. A mail row keeps
// `text` only when it wasn't filed and its sender was proven.
interface ActivityHead {
  id: string;
  at: string;
}
export interface MailActivity extends ActivityHead {
  kind: 'mail';
  message: string;
  received_at: string;
  via: 'reply' | 'address';
  day: string;
  version: string;
  subject: string;
  outcome: 'filed' | 'not-filed' | 'failed';
  reason: string | null;
  sender: string | null;
  text: string | null;
  attempts: number;
  notified: boolean;
}
// One connected assistant's reads on one local day.
export interface ReadsActivity extends ActivityHead {
  kind: 'reads';
  day: string;
  client: string;
  connection: string;
  calls: number;
  tools: Record<string, number>;
  errors?: number;
  last_at: string;
}
// Every other row: its kind (note.added, badge.earned, upcoming.changed …)
// and the fields that kind keeps (packages/domain/activity.ts). An Upcoming
// row's title is read now: null once the date is gone.
export interface EventActivity extends ActivityHead {
  kind: string;
  via?: 'web' | 'email' | 'assistant' | 'import' | 'weekly-thing';
  client?: string;
  day?: string;
  note?: string;
  version?: string;
  files?: number;
  // note.edited: where the note was, set or cleared (never the place)
  place?: 'set' | 'removed';
  added?: number;
  name?: string;
  upcoming?: string;
  title?: string | null;
  changes?: { field: string; from: unknown; to: unknown }[];
  from?: string | null;
  through?: string | null;
  to?: string;
  reason?: string | null;
  how?: string;
  format?: string;
  commentary?: boolean;
  scopes?: string;
  when?: string;
  file?: number;
  empty?: boolean;
  photos?: number;
  app?: string;
  notes?: number;
}
export type ActivityEntry = MailActivity | ReadsActivity | EventActivity;
export interface Activity {
  email: string;
  tz: string;
  today: string;
  entries: ActivityEntry[];
  next: string | null;
}

// GET /api/badges: everything earned, newest first, the tracks, this
// release's album and what is still to find, as of the subscriber's today.
export type Badges = Shelf & { today: string; tz: string; version: string };

// A saved note's answer: what it just earned (none when that couldn't be read).
export type { Unlocked };

// The Map page (GET /api/map/notes): each note with a place of its own and
// coordinates; `exact` is a spot (Here or a photo), not a chosen city.
export interface Pin {
  date: string;
  id: string;
  lat: number;
  lon: number;
  place: string;
  exact: boolean;
  tags: string[];
  /** The release its day falls in, as "5.4". */
  release: string;
  /** Its day's version, as "5.4.113". */
  version: string;
  text: string;
  parts: Part[];
}
export interface MapNotes {
  pins: Pin[];
  notes: number;
}
// POST /api/map/search: the pins with every word, by day and id.
export interface MapSearch {
  terms: string[];
  found: { date: string; id: string }[];
}
