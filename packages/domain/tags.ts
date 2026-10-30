/** Hashtags live in text. Slugs and code-point offsets match the legacy
 * Unicode regex; no channel-specific tags or Markdown interpretation.
 *
 * Letters in any script (Jamie, 2026-10-30: "Approved: build the five API
 * edge cases as recommended: 1, 3 and 4 as API 1.7.0, 2 as its own PR"):
 * a hashtag the legacy slug leaves with no a-z letter, read in full, is a
 * tag of its own letters, lowercased (NFC), its marks kept, so #東京, #שלום
 * and #Москва are tags. One that slugs to a tag today keeps exactly that
 * tag and span, so no stored tag moves: #Café is still cafe. `slug` stays
 * the legacy slug alone, since import keys are made from it. */
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

/** A name as a tag: the legacy slug when it has a-z letters, as every tag
 * before 2026-10-30, otherwise its letters in any script. */
export function tagName(name: string): string {
  const old = slug(name);
  return latin(old) ? old : wide(name);
}
/** A tag as a note's hashtag gives it: already normalized, with a letter. */
export const isTag = (tag: unknown): tag is string =>
  typeof tag === 'string' && valid(tag) && codePointLength(tag) <= MAX_TAG && tagName(tag) === tag;

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
    const tag = slug(chars.slice(start + 1, end).join(''));
    if (latin(tag)) {
      out.push([start, end, tag]);
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
