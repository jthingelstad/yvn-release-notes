// Writing rich text in a plain text box (docs/RICH-TEXT.md): the formatting
// buttons and keys put the marks in as typed, so what is saved is the text
// the box shows. Each edit is one replacement of a range, which the box
// applies as typing would, so Undo takes it back.

export interface Edit {
  /** The range of the old text to replace, and what goes there. */
  from: number;
  to: number;
  insert: string;
  /** The selection afterwards. */
  start: number;
  end: number;
}

export type Mark = 'strong' | 'em';
export type Lines = 'bullets' | 'numbers' | 'quote';

// Stars in a row from i, going forward (1) or back (-1): one is italic, two
// bold, three both.
function stars(text: string, i: number, step: 1 | -1): number {
  let n = 0;
  while (text[step > 0 ? i + n : i - 1 - n] === '*') n++;
  return n;
}
const has = (mark: Mark, left: number, right: number) =>
  mark === 'strong' ? left >= 2 && right >= 2 : left % 2 === 1 && right % 2 === 1;

// A line's list or quote marks, which stay outside bold and italic.
const LEAD = /^(?:[ \t]*(?:> ?|[-*•][ \t]+|\d{1,3}[.)][ \t]+))+/u;

// One line's piece of a selection: spaces at its edges, and a list or quote
// mark when it starts the line, stay outside the marks, which pair only
// around words.
function span(text: string, start: number, end: number): [number, number] {
  for (;;) {
    if (start === 0 || text[start - 1] === '\n') start += LEAD.exec(text.slice(start, end))?.[0].length ?? 0;
    if (start < end && /\s/u.test(text[start] ?? '')) start++;
    else break;
  }
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end--;
  return [start, end];
}
// Whether a piece already has the mark at its own ends.
function marked(inside: string, mark: Mark): boolean {
  const left = stars(inside, 0, 1);
  return left < inside.length && has(mark, left, stars(inside, inside.length, -1));
}

// Bold or italic around the selection, or taken off when it is already
// there. With nothing selected the pair goes in with the caret between.
// Marks pair within a line (domain/rich.ts), so a selection over several
// lines gets a pair on each line with words, and loses them when each has
// them already.
export function wrap(text: string, start: number, end: number, mark: Mark): Edit {
  const d = mark === 'strong' ? '**' : '*';
  [start, end] = span(text, start, end);
  const inside = text.slice(start, end);
  if (inside.includes('\n')) {
    const rows: [number, number][] = [];
    for (let a = start; a <= end;) {
      const nl = text.indexOf('\n', a),
        b = nl < 0 || nl > end ? end : nl;
      const row = span(text, a, b);
      if (row[0] < row[1]) rows.push(row);
      a = b + 1;
    }
    const off = rows.every(([a, b]) => marked(text.slice(a, b), mark));
    let insert = '',
      pos = start;
    for (const [a, b] of rows) {
      const row = text.slice(a, b);
      insert +=
        text.slice(pos, a) + (off ? row.slice(d.length, row.length - d.length) : marked(row, mark) ? row : d + row + d);
      pos = b;
    }
    insert += text.slice(pos, end);
    return { from: start, to: end, insert, start, end: start + insert.length };
  }
  // The marks just outside the selection.
  if (inside && has(mark, stars(text, start, -1), stars(text, end, 1)))
    return { from: start - d.length, to: end + d.length, insert: inside, start: start - d.length, end: end - d.length };
  // The selection's own ends.
  if (marked(inside, mark)) {
    const bare = inside.slice(d.length, inside.length - d.length);
    return { from: start, to: end, insert: bare, start, end: start + bare.length };
  }
  return { from: start, to: end, insert: d + inside + d, start: start + d.length, end: end + d.length };
}

const PREFIX: Record<Lines, RegExp> = {
  bullets: /^- /u,
  numbers: /^\d{1,3}\. /u,
  quote: /^> ?/u
};
// Any list or quote mark a line starts with, taken off before another goes on.
const ANY = /^(?:[-*•] |\d{1,3}[.)] |> ?)/u;

// A list or a quote on every line the selection touches; off again when
// they all have it. Blank lines between stay blank.
export function lines(text: string, start: number, end: number, kind: Lines): Edit {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  let to = text.indexOf('\n', end > start && text[end - 1] === '\n' ? end - 1 : end);
  if (to < 0) to = text.length;
  const rows = text.slice(from, to).split('\n');
  const filled = rows.filter((r) => r.trim());
  const off = filled.length > 0 && filled.every((r) => PREFIX[kind].test(r));
  let n = 0;
  const insert = rows
    .map((r) => {
      if (!r.trim()) return r;
      if (off) return r.replace(PREFIX[kind], '');
      const bare = r.replace(ANY, '');
      return (kind === 'bullets' ? '- ' : kind === 'numbers' ? `${++n}. ` : '> ') + bare;
    })
    .join('\n');
  // A caret on an empty line keeps its place after the new mark.
  const caret = start === end && !rows.join('').trim();
  if (caret) {
    const mark = kind === 'bullets' ? '- ' : kind === 'numbers' ? '1. ' : '> ';
    return { from, to, insert: mark, start: from + mark.length, end: from + mark.length };
  }
  return { from, to, insert, start: start === end ? from + insert.length : from, end: from + insert.length };
}

// What the text becomes with an edit applied.
export const applied = (text: string, e: Edit) => text.slice(0, e.from) + e.insert + text.slice(e.to);

// Cmd or Ctrl with B or I, as in any editor.
export function keyMark(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): Mark | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return null;
  const k = e.key.toLowerCase();
  return k === 'b' ? 'strong' : k === 'i' ? 'em' : null;
}
