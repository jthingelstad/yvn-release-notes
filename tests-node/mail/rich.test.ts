/** Rich text in the email (docs/RICH-TEXT.md): Yesterday and On this day
 * draw a rich day's bold, italic, lists and quotes in the HTML, and show it
 * as typed in the plain text. A plain day is drawn as it always was (the
 * golden fixtures in fixtures/ pin that). Fictional words only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../packages/mail/compose.ts';
import { computeVersion } from '../../packages/domain/version.ts';
import { combined } from '../../packages/domain/rich.ts';
import type { NoteRecord } from '../../packages/domain/notes.ts';

const birthday = '1981-06-14',
  today = '2026-10-13',
  v = computeVersion(birthday, today),
  words =
    'A **long** day at the *lake*.\n\n- towels\n- the paddles\n\n> cold water\n> and **clear**\n\nRead https://example.com/loons after.',
  yesterday = (text: string, rich?: true): c.Yesterday => ({
    day: '2026-10-12',
    text,
    ...(rich ? { rich } : {}),
    links: [{ url: 'https://example.com/loons', title: 'Loons' }],
    tags: [],
    thumbs: [],
    photos: [],
    others: 0,
    places: []
  });

test('a rich Yesterday draws its marks, lists and quotes; the text part shows it as typed', () => {
  const html = c.htmlBody(v, birthday, today, { yesterday: yesterday(words, true) });
  assert.match(
    html,
    /A <strong style="font-weight:700;">long<\/strong> day at the <em style="font-style:italic;">lake<\/em>\./
  );
  assert.match(
    html,
    /<ul style="margin:0 0 12px;padding:0 0 0 26px;[^"]*" class="ink"><li style="margin:0 0 4px;">towels<\/li><li style="margin:0 0 4px;">the paddles<\/li><\/ul>/
  );
  assert.match(
    html,
    /<blockquote style="margin:0 0 12px;padding:0 0 0 18px;">\n<p class="ink-2" [^>]*>cold water<br>and <strong[^>]*>clear<\/strong><\/p>\n<\/blockquote>/
  );
  assert.match(html, /Read <a [^>]*href="https:\/\/example.com\/loons"[^>]*>Loons<\/a>/);
  // Still the email's own rules: ASCII, nothing remote, no rules or boxes.
  assert.ok(Array.from(html).every((ch) => ch.codePointAt(0)! <= 127));
  assert.doesNotMatch(html, /style="[^"]*(?:border|box-shadow)|\*\*long/);
  const text = c.body(v, birthday, { yesterday: yesterday(words, true) });
  assert.ok(text.includes('A **long** day at the *lake*.\n\n- towels\n- the paddles\n\n> cold water\n> and **clear**'));
});

test('the same words in a plain day are drawn as they always were, marks and all', () => {
  const html = c.htmlBody(v, birthday, today, { yesterday: yesterday(words) });
  assert.match(html, /A \*\*long\*\* day at the \*lake\*\./);
  assert.doesNotMatch(html, /<strong style="font-weight:700;"|<em |<ul |<ol |<blockquote/);
});

test('a cut inside bold closes it, and the mark goes after the last word', () => {
  const long = '**' + 'A very long sentence about the lake. '.repeat(40) + 'The end.**',
    html = c.htmlBody(v, birthday, today, { yesterday: yesterday(long, true) }),
    [shown, cut] = c.yesterdayShown(yesterday(long, true));
  assert.equal(cut, true);
  assert.ok(shown.startsWith('**') && shown.endsWith('lake.**'));
  // A whole sentence was kept, so no ellipsis: the cut is at its stop.
  assert.match(html, /<strong style="font-weight:700;">A very long[^<]*lake\.<\/strong><\/p>/);
  assert.doesNotMatch(html, /\*\*/);
  assert.match(html, /Read the rest/);
  const text = c.body(v, birthday, { yesterday: yesterday(long, true) });
  assert.match(text, /lake\.\*\*\n\n/);
});

test('On this day cuts a rich list mid-item with the ellipsis inside the item', () => {
  const list = '- ' + 'word '.repeat(400) + 'end',
    past: c.OnThisDay = {
      shown: [{ day: '2025-10-13', text: list, rich: true, tags: [], thumbs: [], photos: [] }],
      more: []
    },
    html = c.htmlBody(v, birthday, today, { past });
  assert.match(
    html,
    /<li style="margin:0 0 4px;">(?:word )+word&hellip;<\/li><\/ul>|<li style="margin:0 0 4px;">(?:word )+word&#8230;<\/li><\/ul>/
  );
});

test('a day with a rich note and a plain one keeps the plain note as typed', () => {
  const notes = [
      { text: 'A 5* hotel and *stars*.', source: 'email' },
      { text: '- packed\n- **ready**', source: 'web', markup: 'rich' }
    ] as NoteRecord[],
    day = combined(notes),
    html = c.htmlBody(v, birthday, today, { yesterday: { ...yesterday(day.text, day.rich), links: [] } }),
    text = c.body(v, birthday, { yesterday: { ...yesterday(day.text, day.rich), links: [] } });
  assert.match(html, /A 5\* hotel and \*stars\*\./);
  assert.match(html, /<li[^>]*><strong[^>]*>ready<\/strong><\/li>/);
  assert.ok(text.includes('A 5* hotel and *stars*.\n\n- packed\n- **ready**'));
});

test('a plain note’s address ending in _ keeps it, and its name, beside a rich note', () => {
  const notes = [
      { text: 'Read https://example.com/a_ today.', source: 'email' },
      { text: '**ready**', source: 'web', markup: 'rich' }
    ] as NoteRecord[],
    day = combined(notes),
    found = [{ url: 'https://example.com/a_', title: 'Underscores' }],
    html = c.htmlBody(v, birthday, today, { yesterday: { ...yesterday(day.text, day.rich), links: found } }),
    text = c.body(v, birthday, { yesterday: { ...yesterday(day.text, day.rich), links: found } });
  assert.match(html, /Read <a [^>]*href="https:\/\/example.com\/a_"[^>]*>Underscores<\/a> today\./);
  assert.doesNotMatch(html, /&lt;|&gt;/);
  assert.ok(text.includes('Read Underscores <https://example.com/a_> today.'));
});
