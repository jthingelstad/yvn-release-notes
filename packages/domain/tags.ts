/** Tags (docs/TAGS.md; Jamie, 2026-11-08: "Approved: build first-class
 * tags in Release Notes as proposed, with calls 1 to 8 as recommended").
 *
 * A tag has a name, as it was typed and is shown, and a key, which is what
 * matches: "Road Trip", "road trip", "road-trip" and "Road_Trip" are one tag,
 * road-trip. Notes, Upcoming dates, check-ins and remembered places keep
 * their tags in `tags` (keys) and `tag_names` (the same tags, as named).
 * Tags come from a tags field, and from hashtags in a note's text, which
 * still make tags as they always have.
 *
 * Keys stay as they were: a name in Latin letters alone keeps the legacy
 * slug, and one in other scripts alone the letters of 2026-10-30 (Jamie:
 * "Approved: build the five API edge cases as recommended: 1, 3 and 4 as
 * API 1.7.0, 2 as its own PR"), so #Café is still cafe and #東京 is 東京.
 * A name that mixes them, or has emoji, keeps every part: #café-東京 is
 * cafe-東京, where the legacy slug lost 東京. `slug` stays the legacy slug
 * alone, since import keys are made from it. */
import {
  asciiDecompose,
  codePointLength,
  codePointSlice,
  isAlphanumeric,
  pythonRstrip,
  pythonTrim
} from './unicode.ts';
export const MAX_TAG = 50,
  MAX_TAGS = 20;
export type TagSpan = [start: number, end: number, tag: string];
export interface TagPart {
  tag: string;
  text: string;
}

export function slug(name: string): string {
  return asciiDecompose(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG)
    .replace(/-+$/g, '');
}
const latin = (tag: string) => /[a-z]/.test(tag),
  valid = (tag: string) => /\p{L}/u.test(tag),
  mark = (char: string | undefined) => !!char && /^\p{M}$/u.test(char),
  joiner = (char: string | undefined) => char === '\u200c' || char === '\u200d',
  inWord = (char: string | undefined) => !!char && (isAlphanumeric(char) || mark(char));

/** Past one word from `at` (its first character alphanumeric): letters,
 * numbers and marks in any script, a joiner only inside, words joined by
 * single hyphens, as the legacy span joins them. */
function wordsFrom(chars: readonly string[], at: number): number {
  let end = at;
  const word = () => {
    end++;
    while (inWord(chars[end]) || (joiner(chars[end]) && inWord(chars[end + 1]))) end++;
  };
  word();
  while (chars[end] === '-' && chars[end + 1] && isAlphanumeric(chars[end + 1]!)) {
    end++;
    word();
  }
  return end;
}

/** A name's tag in any script: its words, lowercased (NFC), joined by
 * hyphens, at most MAX_TAG code points, never cut inside a letter's marks. */
function wide(name: string): string {
  const chars = Array.from(name.toLowerCase().normalize('NFC')),
    words: string[] = [];
  for (let at = 0; at < chars.length; at++) {
    if (!isAlphanumeric(chars[at]!)) continue;
    let end = at + 1;
    while (inWord(chars[end]) || (joiner(chars[end]) && inWord(chars[end + 1]))) end++;
    words.push(chars.slice(at, end).join(''));
    at = end - 1;
  }
  const out = Array.from(words.join('-'));
  let end = Math.min(out.length, MAX_TAG);
  while (end > 0 && end < out.length && (mark(out[end]) || joiner(out[end - 1]))) end--;
  return out
    .slice(0, end)
    .join('')
    .replace(/[-\u200c\u200d]+$/, '');
}

const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u20e3\u{e0020}-\u{e007f}]/u,
  LATIN = /\p{Script=Latin}/u,
  WORD = /[\p{L}\p{N}]/u,
  // Text and emoji presentation selectors: 🏖 and 🏖️ are one tag.
  PRESENTATION = /[\ufe0e\ufe0f]/gu;

/** A name with emoji, or letters from Latin and another script: each part
 * kept, Latin letters without their accents as the slug has them, the rest
 * lowercased with their marks, emoji as they are, and anything else between
 * words one hyphen. */
function mixed(name: string): string {
  const chars = Array.from(name.normalize('NFC').toLowerCase().replace(PRESENTATION, '')),
    words: string[] = [];
  let word = '',
    folded = false;
  const kept = (char: string | undefined) => !!char && (WORD.test(char) || EMOJI.test(char) || mark(char));
  for (let at = 0; at < chars.length; at++) {
    const char = chars[at]!;
    if (WORD.test(char)) {
      const ascii = asciiDecompose(char);
      if ((LATIN.test(char) && /^[a-z]+$/.test(ascii)) || /^[0-9]$/.test(ascii)) {
        word += ascii;
        folded = true;
      } else {
        word += char;
        folded = false;
      }
    } else if (mark(char)) {
      // A mark stays with a letter kept as it is; an accent goes with its
      // folded letter, as the slug drops it.
      if (word && !folded) word += char;
    } else if (EMOJI.test(char)) {
      word += char;
      folded = false;
    } else if (joiner(char) && word && kept(chars[at + 1])) word += char;
    else if (word) {
      words.push(word);
      word = '';
    }
  }
  if (word) words.push(word);
  const out = Array.from(words.join('-'));
  let end = Math.min(out.length, MAX_TAG);
  while (end > 0 && end < out.length && (mark(out[end]) || joiner(out[end - 1]) || joiner(out[end]))) end--;
  return out
    .slice(0, end)
    .join('')
    .replace(/[-\u200c\u200d]+$/, '');
}

/** A name's key: what matches, so "Road Trip" and "road-trip" are one tag.
 * Latin letters alone keep the legacy slug, and other scripts alone their
 * letters, so no key from before moves; a mix, or emoji, keeps each part. */
export function tagKey(name: string): string {
  const text = name.normalize('NFC'),
    letters = Array.from(text).filter((c) => /\p{L}/u.test(c)),
    latinOnly = letters.every((c) => LATIN.test(c)),
    noLatin = !letters.some((c) => LATIN.test(c));
  if (!EMOJI.test(text)) {
    if (latinOnly) {
      const old = slug(text);
      if (latin(old)) return old;
    } else if (noLatin) return wide(text);
  }
  return mixed(text);
}
/** The key, under the name every caller of before 2026-11-08 knows. */
export const tagName = tagKey;
/** A key as tags are matched by: letters, numbers or emoji, already a key. */
export const isTag = (tag: unknown): tag is string =>
  typeof tag === 'string' && tag !== '' && codePointLength(tag) <= MAX_TAG && tagKey(tag) === tag;

export function spans(text: string): TagSpan[] {
  const chars = Array.from(text || ''),
    out: TagSpan[] = [];
  for (let start = 0; start < chars.length; start++) {
    if (chars[start] !== '#') continue;
    const before = chars[start - 1];
    if (before && (isAlphanumeric(before) || '_#&/='.includes(before))) continue;
    let end = start + 1;
    if (!chars[end] || !isAlphanumeric(chars[end]!)) continue;
    while (end < chars.length && isAlphanumeric(chars[end]!)) end++;
    while (chars[end] === '-' && chars[end + 1] && isAlphanumeric(chars[end + 1]!)) {
      end++;
      while (end < chars.length && isAlphanumeric(chars[end]!)) end++;
    }
    const typed = chars.slice(start + 1, end).join('');
    if (latin(slug(typed))) {
      // Its key: the legacy slug, unless it mixes in another script.
      out.push([start, end, tagKey(typed)]);
      start = end - 1;
      continue;
    }
    // No a-z letter: read on through marks and joiners, and if the whole
    // hashtag still has none, its own letters are the tag.
    const far = wordsFrom(chars, start + 1),
      body = chars.slice(start + 1, far).join(''),
      own = wide(body);
    if (!latin(slug(body)) && valid(own) && tagName(own) === own) {
      out.push([start, far, own]);
      start = far - 1;
    } else start = end - 1;
  }
  return out;
}

export function found(text: string): string[] {
  return [...new Set(spans(text).map(([, , tag]) => tag))].slice(0, MAX_TAGS);
}
/** A tag: its key, which matches, and its name, as typed and shown. */
export interface Tag {
  key: string;
  name: string;
}
/** Why a tags field was refused, for each channel's own error. */
export type TagRefusal = 'list' | 'many' | 'text' | 'break' | 'comma' | 'long' | 'empty';
export const TAG_REFUSALS: Record<TagRefusal, string> = {
  list: 'tags is a list of tag names.',
  many: `A note, date, check-in or place has at most ${MAX_TAGS} tags.`,
  text: 'Each tag is a name, as text.',
  break: 'A tag is one line.',
  comma: 'A tag has no commas: each tag is its own entry.',
  long: `A tag is at most ${MAX_TAG} characters.`,
  empty: 'A tag needs a letter, a number or an emoji.'
};
const SPACES = /[\s\p{Zs}\u180e\u200b\u2060\ufeff]+/gu;

/** A name as a tags field takes it: leading #s and the spaces around it
 * gone, runs of spaces made one, composed (NFC). Commas, line breaks and
 * other control characters are refused, never dropped, as is a name over
 * 50 characters, or one with no letter, number or emoji. */
export function spelling(raw: unknown): Tag | TagRefusal {
  if (typeof raw !== 'string') return 'text';
  const text = raw.normalize('NFC');
  if (/[\n\r\u2028\u2029\u0085]/u.test(text)) return 'break';
  if (/[,\uff0c]/u.test(text)) return 'comma';
  if (/\p{Cc}/u.test(text.replace(/\t/g, ' '))) return 'break';
  const name = text
    .replace(SPACES, ' ')
    .trim()
    .replace(/^#+\s*/, '')
    .trim();
  if (codePointLength(name) > MAX_TAG) return 'long';
  const key = tagKey(name);
  return key ? { key, name } : 'empty';
}

/** A tags field: each name as `spelling` takes it, each tag once (the first
 * name given for a key), at most 20. */
export function fieldTags(value: unknown): Tag[] | { refused: TagRefusal; at: number } {
  if (!Array.isArray(value)) return { refused: 'list', at: -1 };
  const out: Tag[] = [];
  for (const [at, raw] of value.entries()) {
    const tag = spelling(raw);
    if (typeof tag === 'string') return { refused: tag, at };
    if (!out.some((t) => t.key === tag.key)) out.push(tag);
  }
  return out.length > MAX_TAGS ? { refused: 'many', at: MAX_TAGS } : out;
}
export const isRefused = (
  tags: Tag[] | { refused: TagRefusal; at: number }
): tags is { refused: TagRefusal; at: number } => !Array.isArray(tags);

/** The hashtags in a note's text as tags, each named as typed, without its #. */
export function textTags(text: string): Tag[] {
  const out: Tag[] = [];
  for (const [start, end, key] of spans(text)) {
    if (out.length >= MAX_TAGS) break;
    if (!out.some((t) => t.key === key)) out.push({ key, name: codePointSlice(text, start + 1, end) });
  }
  return out;
}

/** Lists of tags as one: each key once, its first name, at most 20. */
export function mergeTags(...lists: readonly (readonly Tag[])[]): Tag[] {
  const out: Tag[] = [];
  for (const list of lists)
    for (const tag of list) if (out.length < MAX_TAGS && !out.some((t) => t.key === tag.key)) out.push(tag);
  return out;
}

/** An item's tags as stored: `tags` and `tag_names` side by side, a key
 * with no name named by itself; an Upcoming date of before 2026-11-08 has
 * one `tag`. Every note was named by the 2026-11-08 migration. */
export function storedTags(item: { tags?: unknown; tag_names?: unknown; tag?: unknown }): Tag[] {
  const keys = Array.isArray(item.tags)
      ? item.tags.map(String)
      : typeof item.tag === 'string' && item.tag
        ? [item.tag]
        : [],
    names = Array.isArray(item.tag_names) ? item.tag_names.map(String) : [];
  return mergeTags(keys.map((key, i) => ({ key, name: names[i] || key })));
}

/** Tags as stored on an item: both lists, or neither when there are none. */
export function tagFields(tags: readonly Tag[]): { tags: string[]; tag_names: string[] } | Record<string, never> {
  return tags.length ? { tags: tags.map((t) => t.key), tag_names: tags.map((t) => t.name) } : {};
}

/** A note's tags when it is written (docs/TAGS.md): the tags field, when it
 * was sent, with the text's hashtags after it; otherwise, for an edit or an
 * append, the tags it had that its old text didn't carry, and the hashtags
 * of its new text. So taking a #word out of the text drops its tag, as it
 * always has, and a tag from a field stays until a field takes it off. */
export function noteTags(
  text: string,
  given: readonly Tag[] | null,
  old?: { text?: unknown; tags?: unknown; tag_names?: unknown } | null
): Tag[] {
  const typed = textTags(text);
  if (given) return mergeTags(given, typed);
  if (!old) return typed;
  const had = new Set(textTags(String(old.text ?? '')).map((t) => t.key)),
    now = new Set(typed.map((t) => t.key));
  return mergeTags(
    storedTags(old).filter((t) => !had.has(t.key) || now.has(t.key)),
    typed
  );
}

export function line(names: readonly string[]): string {
  return [...new Set(names.map(tagName).filter(valid))].map((tag) => `#${tag}`).join(' ');
}
export function split<T>(parts: readonly (string | T)[]): Array<string | T | TagPart> {
  const out: Array<string | T | TagPart> = [];
  for (const part of parts) {
    if (typeof part !== 'string') {
      out.push(part);
      continue;
    }
    let last = 0;
    for (const [start, end, tag] of spans(part)) {
      if (start > last) out.push(codePointSlice(part, last, start));
      out.push({ tag, text: codePointSlice(part, start, end) });
      last = end;
    }
    const rest = codePointSlice(part, last);
    if (rest) out.push(rest);
  }
  return out;
}
export function withoutClosing(text: string): string {
  const lines = pythonRstrip(text || '').split('\n');
  while (lines.length) {
    const last = lines.at(-1)!,
      matches = spans(last);
    let rest = last;
    for (const [start, end] of matches.toReversed()) rest = codePointSlice(rest, 0, start) + codePointSlice(rest, end);
    if (!matches.length || pythonTrim(rest)) break;
    lines.pop();
  }
  return pythonRstrip(lines.join('\n'));
}
/** The tag row's tap (docs/API.md, Tags): `#tag` added at the end, on the
 * same line, unless the text has it; or, when it does, every `#tag` for it
 * taken out with the space beside it. */
export function addingTag(text: string, tag: string): string {
  if (!valid(tag) || spans(text).some(([, , t]) => t === tag)) return text;
  const kept = pythonRstrip(text || '');
  return kept ? `${kept} #${tag}` : `#${tag} `;
}
export function removingTag(text: string, tag: string): string {
  const chars = Array.from(text || '');
  for (const [start, end, t] of spans(text).toReversed()) {
    if (t !== tag) continue;
    const before = start > 0 && chars[start - 1] === ' ',
      after = !before && chars[end] === ' ';
    chars.splice(before ? start - 1 : start, end - start + (before || after ? 1 : 0));
  }
  return chars.join('');
}
export const togglingTag = (text: string, tag: string): string =>
  spans(text).some(([, , t]) => t === tag) ? removingTag(text, tag) : addingTag(text, tag);

/** One tag across everything: its key, the name it was given last, and how
 * many notes (on how many days), Upcoming dates and check-ins have it, with
 * the first and last day of its notes and check-ins (null for a tag only an
 * Upcoming date has). */
export interface TagTotal {
  tag: string;
  name: string;
  notes: number;
  days: number;
  first: string | null;
  last: string | null;
  upcoming: number;
  check_ins: number;
}
type Tagged = { tags?: unknown; tag_names?: unknown; tag?: unknown; text?: unknown };

/** Every tag, most used first: the web's Tags page and `/v1/tags/all`. Notes
 * come as `noteTags` reads them (their day in `sk`), check-ins with their
 * `day`, Upcoming dates as they are; each tag is named as its latest note or
 * check-in names it, or else an Upcoming date. */
export function tagTotals(
  notes: readonly (Tagged & { sk?: unknown })[],
  upcoming: readonly Tagged[] = [],
  checkIns: readonly (Tagged & { day?: unknown })[] = []
): TagTotal[] {
  const counts = new Map<string, TagTotal & { on: Set<string>; named: string }>(),
    entry = (tag: Tag) => {
      let e = counts.get(tag.key);
      if (!e) {
        e = {
          tag: tag.key,
          name: tag.name,
          notes: 0,
          days: 0,
          first: null,
          last: null,
          upcoming: 0,
          check_ins: 0,
          on: new Set(),
          named: ''
        };
        counts.set(tag.key, e);
      }
      return e;
    },
    dated = (e: TagTotal & { named: string }, tag: Tag, d: string) => {
      if (e.first === null || d < e.first) e.first = d;
      if (e.last === null || d > e.last) e.last = d;
      // The name of its latest use: a later day, or the same day again.
      if (d >= e.named) {
        e.named = d;
        e.name = tag.name;
      }
    };
  for (const n of notes) {
    const d = String(n.sk).split('#')[1]!;
    for (const tag of storedTags(n)) {
      const e = entry(tag);
      e.notes++;
      e.on.add(d);
      dated(e, tag, d);
    }
  }
  for (const c of checkIns)
    for (const tag of storedTags(c)) {
      const e = entry(tag);
      e.check_ins++;
      dated(e, tag, String(c.day ?? ''));
    }
  for (const u of upcoming) for (const tag of storedTags(u)) entry(tag).upcoming++;
  return [...counts.values()]
    .sort(
      (a, b) =>
        b.notes + b.check_ins + b.upcoming - (a.notes + a.check_ins + a.upcoming) ||
        b.notes - a.notes ||
        (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)
    )
    .map(({ on, named: _, ...e }) => ({ ...e, days: on.size }));
}
