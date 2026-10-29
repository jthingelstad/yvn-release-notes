/** Hashtags live in text. Slugs and code-point offsets match the legacy
 * Unicode regex; no channel-specific tags or Markdown interpretation. */
import { asciiDecompose, codePointSlice, isAlphanumeric, pythonRstrip, pythonTrim } from './unicode.ts';
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
const valid = (tag: string) => /[a-z]/.test(tag);

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
    if (valid(tag)) out.push([start, end, tag]);
    start = end - 1;
  }
  return out;
}

export function found(text: string): string[] {
  return [...new Set(spans(text).map(([, , tag]) => tag))].slice(0, MAX_TAGS);
}
export function line(names: readonly string[]): string {
  return [...new Set(names.map(slug).filter(valid))].map((tag) => `#${tag}`).join(' ');
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
