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
  today: string;
  version: string;
  city?: string;
  region?: string;
  country?: string;
  pause?: { from: string; through: string };
  pause_starts: string;
  // the standing address, for a note by email any day (inbound.py)
  inbox?: string;
}

export interface Sample {
  version: string;
  age: string;
  next: { version: string; date: string; days: number };
}

export interface Place {
  name: string;
  region?: string;
  country?: string;
  tz: string;
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
  via?: 'web' | 'email' | 'assistant' | 'import';
  client?: string;
  day?: string;
  note?: string;
  version?: string;
  files?: number;
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
