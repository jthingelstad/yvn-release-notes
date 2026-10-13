/** Legacy Unicode semantics shared by every channel. Search uses Python's
 * full casefold, NFKD and nonzero-combining removal (Unicode 16), not locale
 * lowercasing. Generated tables preserve existing tags/search across runtimes. */
import { alnumRanges, asciiMap, decimalMap, foldMap } from './unicode-data.ts';

export const codePointLength = (text: string): number => Array.from(text).length;
export const codePointSlice = (text: string, start = 0, end?: number): string =>
  Array.from(text).slice(start, end).join('');

const whitespace =
  '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const leading = new RegExp(`^${whitespace}+`);
const trailing = new RegExp(`${whitespace}+$`);
export const pythonTrim = (text: string): string => text.replace(leading, '').replace(trailing, '');
export const pythonRstrip = (text: string): string => text.replace(trailing, '');
export const isWhitespace = (char: string): boolean => new RegExp(`^${whitespace}$`).test(char);

export function isAlphanumeric(char: string): boolean {
  const cp = char.codePointAt(0);
  if (cp === undefined) return false;
  let lo = 0,
    hi = alnumRanges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [first, last] = alnumRanges[mid]!;
    if (cp < first) hi = mid - 1;
    else if (cp > last) lo = mid + 1;
    else return true;
  }
  return false;
}

export function fold(text: string): string {
  let out = '';
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp >= 0xac00 && cp <= 0xd7a3) {
      const syllable = cp - 0xac00;
      out += String.fromCodePoint(0x1100 + Math.floor(syllable / 588), 0x1161 + Math.floor((syllable % 588) / 28));
      if (syllable % 28) out += String.fromCodePoint(0x11a7 + (syllable % 28));
    } else out += foldMap[char] ?? char;
  }
  return out;
}

/** NFKD followed by ASCII-ignore, as used for stored tag slugs. */
export function asciiDecompose(text: string): string {
  let out = '';
  for (const char of text) out += char.codePointAt(0)! < 128 ? char : (asciiMap[char] ?? '');
  return out;
}

export function decimalDigit(char: string): number | undefined {
  return /^[0-9]$/.test(char) ? Number(char) : decimalMap[char];
}
