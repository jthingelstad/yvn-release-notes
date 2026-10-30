/** Rich text (docs/RICH-TEXT.md): the subset, its strict pairing, and the
 * helpers the email, search and the book use. Fictional words only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asTyped,
  blocks,
  closeCut,
  combined,
  escapePlain,
  flat,
  isRich,
  plainWords,
  webParts,
  type Block
} from '../../packages/domain/rich.ts';
import { combine, type NoteRecord } from '../../packages/domain/notes.ts';

type Url = { url: string };
const read = (text: string) => blocks(webParts(text));
// A block's lines as text, marks shown as <b> and <i>, links as [url].
const shown = (written: Block<Url>[]): unknown[] =>
  written.map((b) => {
    const words = (l: { text?: string; atom?: Url; strong?: boolean; em?: boolean }[]) =>
      l
        .map((bit) => {
          let w = bit.atom ? `[${bit.atom.url}]` : bit.text!;
          if (bit.em) w = `<i>${w}</i>`;
          if (bit.strong) w = `<b>${w}</b>`;
          return w;
        })
        .join('');
    if (b.kind === 'para') return ['para', ...b.lines.map(words)];
    if (b.kind === 'quote') return ['quote', ...shown(b.blocks)];
    if (b.kind === 'numbers') return ['numbers', b.start, ...b.items.map((rows) => rows.map(words).join(' / '))];
    return ['bullets', ...b.items.map((rows) => rows.map(words).join(' / '))];
  });

test('a note is rich only when it says so; everything else is plain', () => {
  assert.equal(isRich({ markup: 'rich' }), true);
  for (const n of [{}, { markup: 'Rich' }, { markup: true }, null, 'rich', undefined]) assert.equal(isRich(n), false);
});

test('bold and italic pair around words, and only there', () => {
  assert.deepEqual(shown(read('A **long** day at the *lake* and _the dock_, ***both***.')), [
    ['para', 'A <b>long</b> day at the <i>lake</i> and <i>the dock</i>, <b><i>both</i></b>.']
  ]);
  // Stars and underscores that don't pair stay what they are.
  for (const text of [
    'A 5* hotel, 2*3*4 = 24 and snake_case_name.',
    'An ** open bold and a * lone star.',
    '**not closed',
    'a*b*c and x_y_z',
    '*not closed either and _nor this'
  ])
    assert.deepEqual(shown(read(text)), [['para', text]]);
  // Pairs stay within a line.
  assert.deepEqual(shown(read('*one\ntwo*')), [['para', '*one', 'two*']]);
});

test('lists, numbered lists and quotes are lines that start with their marks', () => {
  assert.deepEqual(
    shown(
      read(
        'Packed:\n- towels\n* a **dry** bag\n  that floats\n\n3. third\n4) fourth\n\n> cold water\n> and *clear*\n\nAfter.'
      )
    ),
    [
      ['para', 'Packed:'],
      ['bullets', 'towels', 'a <b>dry</b> bag / that floats'],
      ['numbers', 3, 'third', 'fourth'],
      ['quote', ['para', 'cold water', 'and <i>clear</i>']],
      ['para', 'After.']
    ]
  );
  // A dash with nothing after it, a rule and an em dash line are words.
  assert.deepEqual(shown(read('-\n---\n-- two dashes\n—one')), [['para', '-', '---', '-- two dashes', '—one']]);
  // 1000. is a year, not a list.
  assert.deepEqual(shown(read('1999. A good year.')), [['para', '1999. A good year.']]);
});

test('a backslash keeps a mark as typed, and links are never read for marks', () => {
  assert.deepEqual(shown(read('\\*not italic\\* and \\- this')), [['para', '*not italic* and - this']]);
  assert.deepEqual(shown(read('See https://example.com/a_b_c_ and **https://example.com/x**.')), [
    ['para', 'See [https://example.com/a_b_c]_ and <b>[https://example.com/x]</b>.']
  ]);
  // In rich text an address's last * or _ is read as a mark (links.ts
  // TRAILING_RICH), as its last full stop is read as the sentence's.
  // Plain parsing keeps a trailing underscore in an address.
  assert.deepEqual(webParts('https://example.com/a_', false), [{ url: 'https://example.com/a_' }]);
});

test('search and previews read the words without the marks', () => {
  assert.equal(plainWords('A **long** day.\n\n- one\n- *two*\n\n> quoted'), 'A long day.\n\none\ntwo\n\nquoted');
  assert.deepEqual(flat(read('**a**\nb'), ' '), ['a', ' ', 'b']);
});

test('plain text escaped reads back as the same words, and as typed loses the backslashes', () => {
  for (const text of [
    'A 5* hotel. *Not* italic, **not** bold, snake_case.',
    '- not a list\n> not a quote\n1. not a number\n• nor this',
    'https://example.com/a_b_ stays whole, and \\ a backslash.'
  ]) {
    const escaped = escapePlain(text);
    assert.equal(plainWords(escaped), text);
    assert.equal(asTyped(escaped), text);
  }
});

test('an excerpt cut inside bold or italic closes it, and nothing else', () => {
  assert.equal(closeCut('**Big day. Then more** after.', '**Big day.'), '**Big day.**');
  assert.equal(closeCut('- I *loved the lake. It was* cold.', '- I *loved the lake.'), '- I *loved the lake.*');
  assert.equal(closeCut('A *lone star. And more.', 'A *lone star.'), 'A *lone star.');
  assert.equal(closeCut('Plain. Words.', 'Plain.'), 'Plain.');
});

test('a day with a rich note reads as rich, its plain notes escaped; without one, as it always did', () => {
  const plain: NoteRecord = { text: 'A 5* hotel.' } as NoteRecord,
    rich: NoteRecord = { text: 'A **long** day.', markup: 'rich' } as NoteRecord;
  assert.deepEqual(combined([plain, { ...plain, text: '- dash' } as NoteRecord]), {
    text: combine([plain, { ...plain, text: '- dash' } as NoteRecord])
  });
  const day = combined([plain, rich]);
  assert.equal(day.rich, true);
  assert.equal(plainWords(day.text), plainWords(escapePlain('A 5* hotel.')) + '\n\nA long day.');
});

test('a rich note’s map preview is its words without the marks; a plain one keeps them', async () => {
  const { pins } = await import('../../packages/backend/maps.ts'),
    place = { lat: 44.98, lon: -93.26, name: 'Lake Harriet' },
    [rich, plain] = pins(
      [
        { sk: 'NOTE#2026-10-12#a', text: 'A **long** day.\n\n- towels\n- *paddles*', markup: 'rich', place },
        { sk: 'NOTE#2026-10-12#b', text: 'A **long** day.', place }
      ] as unknown as NoteRecord[],
      '1981-06-14'
    );
  assert.equal(rich!.text, 'A long day. towels paddles');
  assert.equal(plain!.text, 'A **long** day.');
});
