/** Rich text (docs/RICH-TEXT.md): a small Markdown-like subset, read only in
 * a note stamped `markup: 'rich'` when it was written. Every other note is
 * plain text, read exactly as before, so nothing already written changes
 * meaning, and the stored text is always the text as typed.
 *
 * The subset: **bold** (or __bold__), *italic* (or _italic_), lines starting
 * "- ", "* " or "• " as a bulleted list, "1. " or "1) " as a numbered one,
 * "> " as a quote, a blank line between paragraphs and a newline as a line
 * break. No headings, code, tables, images or [label](url) links. A
 * backslash before punctuation keeps it as typed.
 *
 * Links and hashtags are found first (links.segments, tags.split) and come
 * in as atoms: markup never splits one, and one can sit inside bold or
 * italic. Emphasis pairs strictly, within one line: a run opens only where
 * it touches a word on its right and not on its left, and closes the other
 * way round, so "5* hotel", "2*3*4" and snake_case stay as typed. */
import { isWhitespace } from './unicode.ts';
import { combine, type NoteRecord } from './notes.ts';

export const RICH = 'rich';
export const isRich = (note: unknown): boolean =>
  typeof note === 'object' && note !== null && (note as { markup?: unknown }).markup === RICH;

export interface Marks {
  strong?: true;
  em?: true;
}
export type Inline<T> = (Marks & { text: string }) | (Marks & { atom: T });
export type Line<T> = Inline<T>[];
export type Block<T> =
  | { kind: 'para'; lines: Line<T>[] }
  | { kind: 'bullets'; items: Line<T>[][] }
  | { kind: 'numbers'; start: number; items: Line<T>[][] }
  | { kind: 'quote'; blocks: Block<T>[] };

// One code point, or one atom, with where it was in its line's text.
type Unit<T> = { c: string; lit?: true; at: number } | { atom: T; at: number };
const isChar = <T>(u: Unit<T> | undefined): u is { c: string; lit?: true; at: number } => !!u && 'c' in u;

const QUOTE = /^ {0,3}> ?/u,
  BULLET = /^[ \t]*[-*•][ \t]+/u,
  NUMBER = /^[ \t]*(\d{1,3})[.)][ \t]+/u,
  // What a backslash keeps as typed: ASCII punctuation, and the bullet.
  ESCAPABLE = /^[!-/:-@[-`{-~•]$/u,
  // The bare web addresses links.ts finds, so markup inside one is left alone.
  WEB = /<?https?:\/\/[^\s<>"]+>?/giu;

// `width` is how many code points an atom stood for in the text, so `at`
// stays an offset into the line as typed (closeCut compares it with a cut).
function linesOf<T>(parts: readonly (string | T)[], width: (atom: T) => number = () => 1): Unit<T>[][] {
  const out: Unit<T>[][] = [[]];
  let at = 0;
  for (const part of parts) {
    if (typeof part !== 'string') {
      out.at(-1)!.push({ atom: part, at });
      at += width(part);
      continue;
    }
    for (const c of part.replace(/\r\n?/gu, '\n')) {
      if (c === '\n') {
        out.push([]);
        at = 0;
      } else out.at(-1)!.push({ c, at: at++ });
    }
  }
  return out;
}
// The line's text up to its first atom: where its block marker would be.
function lead<T>(line: Unit<T>[]): string {
  let s = '';
  for (const u of line) {
    if (!isChar(u)) break;
    s += u.c;
  }
  return s;
}
const blank = <T>(line: Unit<T>[]) => line.every((u) => isChar(u) && isWhitespace(u.c));
// The line without its first `n` code points (a marker), atoms kept.
const drop = <T>(line: Unit<T>[], n: number) => line.slice(n);
function item<T>(line: Unit<T>[]): { kind: 'bullets' | 'numbers'; n: number; rest: Unit<T>[] } | null {
  const head = lead(line),
    bullet = BULLET.exec(head),
    number = bullet ? null : NUMBER.exec(head),
    found = bullet ?? number;
  if (!found) return null;
  const rest = drop(line, Array.from(found[0]).length);
  if (blank(rest)) return null;
  return { kind: bullet ? 'bullets' : 'numbers', n: number ? Number(number[1]) : 1, rest };
}

function parseBlocks<T>(lines: Unit<T>[][]): Block<T>[] {
  const out: Block<T>[] = [];
  let i = 0;
  const quoted = (line: Unit<T>[]) => QUOTE.exec(lead(line));
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (quoted(line)) {
      const inner: Unit<T>[][] = [];
      for (let q = quoted(lines[i]!); i < lines.length && q; q = lines[++i] ? quoted(lines[i]!) : null)
        inner.push(drop(lines[i]!, Array.from(q[0]).length));
      out.push({ kind: 'quote', blocks: parseBlocks(inner) });
      continue;
    }
    const first = item(line);
    if (first) {
      const items: Line<T>[][] = [];
      while (i < lines.length) {
        const next = item(lines[i]!);
        if (next?.kind === first.kind) items.push([inline(next.rest)]);
        // An indented line straight under an item goes on with it.
        else if (!next && !blank(lines[i]!) && /^[ \t]{2,}/u.test(lead(lines[i]!)))
          items.at(-1)!.push(inline(lines[i]!.slice(lead(lines[i]!).search(/\S/u))));
        else break;
        i++;
      }
      out.push(first.kind === 'bullets' ? { kind: 'bullets', items } : { kind: 'numbers', start: first.n, items });
      continue;
    }
    const para: Line<T>[] = [];
    while (i < lines.length && !blank(lines[i]!) && !quoted(lines[i]!) && !item(lines[i]!))
      para.push(inline(lines[i++]!));
    out.push({ kind: 'para', lines: para });
  }
  return out;
}

type Kind = 'space' | 'punct' | 'word';
const kindOf = <T>(u: Unit<T> | undefined): Kind =>
  !u ? 'space' : !isChar(u) ? 'word' : isWhitespace(u.c) ? 'space' : /[\p{P}\p{S}]/u.test(u.c) ? 'punct' : 'word';
interface Run {
  c: string;
  start: number;
  end: number;
  open: boolean;
  close: boolean;
}
interface Pair {
  c: string;
  open: number;
  close: number;
  use: number;
}
// Backslash escapes: the backslash goes, and what it kept is never markup.
function unescaped<T>(units: Unit<T>[]): Unit<T>[] {
  const out: Unit<T>[] = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!,
      next = units[i + 1];
    if (isChar(u) && !u.lit && u.c === '\\' && isChar(next) && ESCAPABLE.test(next.c)) {
      out.push({ c: next.c, lit: true, at: next.at });
      i++;
    } else out.push(u);
  }
  return out;
}
// Which runs of * and _ pair, as CommonMark's emphasis, kept strict: no run
// inside a word opens or closes, and nothing pairs across a line.
function pairs<T>(units: Unit<T>[]): Pair[] {
  const runs: Run[] = [];
  for (let i = 0; i < units.length;) {
    const u = units[i]!;
    if (!isChar(u) || u.lit || (u.c !== '*' && u.c !== '_')) {
      i++;
      continue;
    }
    let end = i + 1;
    while (
      end < units.length &&
      isChar(units[end]) &&
      !(units[end] as { lit?: true }).lit &&
      (units[end] as { c: string }).c === u.c
    )
      end++;
    const before = kindOf(units[i - 1]),
      after = kindOf(units[end]),
      left = after !== 'space' && (after !== 'punct' || before !== 'word'),
      right = before !== 'space' && (before !== 'punct' || after !== 'word');
    runs.push({
      c: u.c,
      start: i,
      end,
      open: left && (!right || before === 'punct'),
      close: right && (!left || after === 'punct')
    });
    i = end;
  }
  const found: Pair[] = [],
    stack: Run[] = [];
  for (const run of runs) {
    while (run.close && run.end > run.start) {
      let at = stack.length - 1;
      while (at >= 0 && stack[at]!.c !== run.c) at--;
      if (at < 0) break;
      const opener = stack[at]!,
        use = opener.end - opener.start >= 2 && run.end - run.start >= 2 ? 2 : 1;
      found.push({ c: run.c, open: opener.end - use, close: run.start, use });
      opener.end -= use;
      run.start += use;
      stack.splice(opener.end > opener.start ? at + 1 : at);
    }
    if (run.open && run.end > run.start) stack.push(run);
  }
  return found;
}
function inline<T>(raw: Unit<T>[]): Line<T> {
  const units = unescaped(raw),
    hidden = new Set<number>(),
    strong = new Array<number>(units.length + 1).fill(0),
    em = new Array<number>(units.length + 1).fill(0);
  for (const p of pairs(units)) {
    for (let k = 0; k < p.use; k++) hidden.add(p.open + k).add(p.close + k);
    const depth = p.use === 2 ? strong : em;
    depth[p.open + p.use]!++;
    depth[p.close]!--;
  }
  const out: Line<T> = [];
  let s = 0,
    e = 0;
  units.forEach((u, i) => {
    s += strong[i]!;
    e += em[i]!;
    if (hidden.has(i)) return;
    const marks: Marks = { ...(s > 0 ? { strong: true as const } : {}), ...(e > 0 ? { em: true as const } : {}) },
      last = out.at(-1);
    if (!isChar(u)) out.push({ atom: u.atom, ...marks });
    else if (last && 'text' in last && !!last.strong === !!marks.strong && !!last.em === !!marks.em) last.text += u.c;
    else out.push({ text: u.c, ...marks });
  });
  return out;
}

/** A rich note's words as blocks: `parts` is its text as links.segments and
 * tags.split leave it, strings and atoms (a link, a tag). */
export function blocks<T>(parts: readonly (string | T)[]): Block<T>[] {
  return parseBlocks(linesOf(parts));
}

/** Plain text with its bare web addresses as atoms, for the readers here that
 * have no named links to hand (search, the cut, escaping). An address ends
 * as links.ts ends it: in a rich note a closing * or _ is not part of it. */
export function webParts(text: string, rich = true): (string | { url: string })[] {
  const out: (string | { url: string })[] = [],
    trailing = rich ? /[.,;:!?'")\]}*_]+$/u : /[.,;:!?'")\]}]+$/u;
  let last = 0;
  for (const m of text.matchAll(WEB)) {
    const whole = m[0],
      url = whole.startsWith('<') && whole.endsWith('>') ? whole : whole.replace(trailing, '');
    if (!url) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ url });
    last = m.index + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const lineWords = <T>(line: Line<T>, atom: (a: T) => string) =>
  line.map((s) => ('text' in s ? s.text : atom(s.atom))).join('');
/** The words without the markup, a line a line: what search reads. */
export function words<T>(written: Block<T>[], atom: (a: T) => string): string {
  return written
    .map((b) =>
      b.kind === 'para'
        ? b.lines.map((l) => lineWords(l, atom)).join('\n')
        : b.kind === 'quote'
          ? words(b.blocks, atom)
          : b.items.map((it) => it.map((l) => lineWords(l, atom)).join('\n')).join('\n')
    )
    .join('\n\n');
}
/** The blocks back as one run of strings and atoms, without their markup,
 * a line a `gap` apart: for a preview that reads a note's words alone. */
export function flat<T>(written: Block<T>[], gap = '\n'): (string | T)[] {
  const out: (string | T)[] = [];
  const line = (l: Line<T>) => {
    if (out.length) out.push(gap);
    for (const s of l) out.push('text' in s ? s.text : s.atom);
  };
  const walk = (bs: Block<T>[]) => {
    for (const b of bs)
      if (b.kind === 'para') b.lines.forEach(line);
      else if (b.kind === 'quote') walk(b.blocks);
      else for (const it of b.items) it.forEach(line);
  };
  walk(written);
  return out;
}
/** A rich note's text with the markup taken out (search, MCP's plain view). */
export const plainWords = (text: string): string => words(blocks(webParts(text)), (a) => a.url);

/** A plain note's text, escaped so it reads as typed beside rich ones (a
 * day of notes is one text in the email). Web addresses are left whole: one
 * that ends in * or _, which a rich reading would leave out of it, goes in
 * angle brackets, which keep an address whole and show as nothing. */
export function escapePlain(text: string): string {
  return webParts(text, false)
    .map((p) =>
      typeof p !== 'string'
        ? /^<.*>$/su.test(p.url) || !/[*_]$/u.test(p.url)
          ? p.url
          : p.url.replace(/^(<?)(.*)$/su, '$1<$2>')
        : p
            .replace(/[\\*_]/gu, '\\$&')
            .replace(/(^|\n)([ \t]*)([-•>]|\d{1,3}(?=[.)]))/gu, (_, start: string, gap: string, mark: string) =>
              /^\d/u.test(mark) ? `${start}${gap}${mark}\\` : `${start}${gap}\\${mark}`
            )
    )
    .join('');
}
/** The text as typed, for plain-text readers (the email's text part): only
 * the backslashes go, outside web addresses. */
export function asTyped(text: string): string {
  return webParts(text)
    .map((p) => (typeof p !== 'string' ? p.url : p.replace(/\\([!-/:-@[-`{-~•])/gu, '$1')))
    .join('');
}

/** `shown` cut from the front of `full` (Yesterday, On this day): any bold
 * or italic the cut left open is closed, so the excerpt reads as the note
 * does and never shows a stray marker. */
export function closeCut(full: string, shown: string): string {
  if (!full.startsWith(shown) || full.length === shown.length) return shown;
  const from = shown.lastIndexOf('\n') + 1,
    to = full.indexOf('\n', from),
    whole = full.slice(from, to < 0 ? undefined : to),
    cut = Array.from(shown.slice(from)).length;
  let units = linesOf(webParts(whole), (a) => Array.from(a.url).length)[0] ?? [];
  // The line's block marker is not emphasis.
  for (let m = QUOTE.exec(lead(units)); m; m = QUOTE.exec(lead(units))) units = drop(units, Array.from(m[0]).length);
  const marked = BULLET.exec(lead(units)) ?? NUMBER.exec(lead(units));
  if (marked) units = drop(units, Array.from(marked[0]).length);
  const kept = unescaped(units),
    open = pairs(kept)
      .filter((p) => kept[p.open]!.at < cut && kept[p.close]!.at >= cut)
      .toSorted((a, b) => b.open - a.open);
  return shown + open.map((p) => p.c.repeat(p.use)).join('');
}

/** A day's notes as one text, as notes.combine joins them (the email's
 * Yesterday and On this day). A day with no rich note is exactly what it was.
 * With one, the plain notes are escaped so they still read as typed, and the
 * whole day is read as rich. */
export function combined(notes: readonly NoteRecord[]): { text: string; rich?: true } {
  if (!notes.some(isRich)) return { text: combine(notes) };
  return {
    text: combine(
      notes.map((n) => (isRich(n) ? n : { ...n, text: escapePlain(String(n.text ?? '')) })),
      { label: escapePlain }
    ),
    rich: true
  };
}
