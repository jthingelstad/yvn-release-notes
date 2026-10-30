/** A note's words from every channel (API edge case 3, 2026-10-30): control
 * characters but tab and newline dropped, a lone surrogate replaced or
 * refused, everything visible kept. Built from code points so no escape
 * hides in the source. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteWords } from '../../packages/domain/notes.ts';
import { wellFormed } from '../../packages/domain/unicode.ts';
import { textFrom } from '../../server/app/requests.ts';

const c = (...points: number[]) => String.fromCodePoint(...points),
  lone = String.fromCharCode(0xd83d);

test('control characters go, tab and newline stay, line endings are newlines', () => {
  assert.equal(noteWords(`Bell${c(7)} NUL${c(0)} ESC${c(0x1b)}[31m red${c(0x7f)}${c(0x9b)}`), 'Bell NUL ESC[31m red');
  assert.equal(noteWords('one\ttwo\r\nthree\rfour\nfive'), 'one\ttwo\nthree\nfour\nfive');
  assert.equal(noteWords(`${c(0xfeff)}  Hi  `), 'Hi');
  assert.equal(noteWords(`form${c(0x0c)}feed and${c(0x0b)}tab`), 'formfeed andtab');
  assert.equal(noteWords(`${c(0)}${c(1)}`), '');
});

test('what real text needs stays: joiners, variation selectors, direction marks, emoji', () => {
  const family = c(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
    heart = c(0x2764, 0xfe0f),
    hebrew = c(0x200f) + c(0x05e9, 0x05dc, 0x05d5, 0x05dd),
    isolate = c(0x2067) + 'abc' + c(0x2069),
    nbsp = 'a' + c(0xa0) + 'b',
    zwnj = c(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0645);
  for (const text of [family, heart, hebrew, isolate, nbsp, zwnj, 'café #mañana']) assert.equal(noteWords(text), text);
});

test('a lone surrogate is half a character: refused where it can be, else replaced', () => {
  assert.equal(noteWords(`half ${lone} done`), `half ${c(0xfffd)} done`);
  assert.equal(noteWords(c(0x1f600)), c(0x1f600));
  assert.equal(wellFormed({ text: `half ${lone}` }), false);
  assert.equal(wellFormed({ [`key${lone}`]: 'x' }), false);
  assert.equal(wellFormed({ place: { name: ['ok', lone] } }), false);
  assert.equal(wellFormed({ text: c(0x1f600), n: 3, ok: true, none: null }), true);
});

test('the web keeps a note the same way', () => {
  assert.equal(textFrom({ text: `Saved${c(0x1b)}[0m\r\nfrom the web` }), 'Saved[0m\nfrom the web');
});
