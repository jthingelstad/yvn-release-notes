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

// Bold or italic around the selection, or taken off when it is already
// there. With nothing selected the pair goes in with the caret between.
// Spaces at a selection's edges stay outside the marks, which pair only
// around words.
export function wrap(text: string, start: number, end: number, mark: Mark): Edit {
  const d = mark === 'strong' ? '**' : '*';
  while (start < end && /\s/u.test(text[start] ?? '')) start++;
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end--;
  const inside = text.slice(start, end);
  // The marks just outside the selection.
  if (inside && has(mark, stars(text, start, -1), stars(text, end, 1)))
    return { from: start - d.length, to: end + d.length, insert: inside, start: start - d.length, end: end - d.length };
  // The selection's own ends.
  const left = stars(inside, 0, 1);
  const right = stars(inside, inside.length, -1);
  if (left < inside.length && has(mark, left, right)) {
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
