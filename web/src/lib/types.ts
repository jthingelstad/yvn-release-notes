// What the API answers (src/release_notes/web.py), as the pages read it.

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
  transcript?: string;
  description?: string;
  writing?: boolean;
}

export interface Note {
  id: string;
  source: 'email' | 'web' | 'import';
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
}

export interface DaysPage {
  today: string;
  tz: string;
  days: Day[];
  before?: string | null;
}

export interface Me {
  new: boolean;
  email: string;
  birthday: string;
  tz: string;
  send_time: string;
  status: 'active' | 'stopped';
  stopped_reason?: 'unsubscribed' | 'bounce' | 'complaint';
  transcribe: boolean;
  describe: boolean;
  today: string;
  version: string;
  city?: string;
  region?: string;
  country?: string;
  pause?: { from: string; through: string };
  pause_starts: string;
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
