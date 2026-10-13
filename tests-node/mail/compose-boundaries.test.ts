/** Grouped copy/cut boundaries that are distinct from the complete MIME goldens. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../packages/mail/compose.ts';
import { computeVersion } from '../../packages/domain/version.ts';
test('streak copy preserves first, broken, singular, record and below-record branches without calling out a break', () => {
  const v = computeVersion('1981-06-20', '2026-10-08');
  for (const [current, longest, lines] of [
    [0, 0, ['Every reply starts a streak.', "Today's can be the first."]],
    [0, 12, ['Every reply starts a streak.', 'Your longest so far is 12 days.']],
    [1, 1, ['1 day in a row.', `Reply today and ${v} makes it 2.`]],
    [5, 5, ['5 days in a row, your longest yet.', `Reply today and ${v} makes it 6.`]],
    [4, 12, ['4 days in a row.', `Your longest is 12 days. Reply today and ${v} makes it 5.`]]
  ] as const)
    assert.deepEqual(c.streakLines(v, { current, longest, days: [] }), lines);
  assert.equal(c.lifetimeLine({ notes: 1, days: 1, photos: 0, since: 2026 }), '1 note across 1 day since 2026.');
  assert.equal(
    c.filesLine({ image: 1, audio: 1, file: 1 }, 1),
    '1 photo, 1 recording, 1 file, 1 attachment in the original email'
  );
});
test('yesterday falls back to whole words, excludes overlong URLs and places a cut marker outside a complete link', () => {
  const longSentence = 'one two three four five six seven eight nine ten';
  assert.deepEqual(c.sentenceText(longSentence, 22), ['one two three four', true]);
  const url = 'https://example.com/' + 'a'.repeat(1200),
    yesterday = {
      day: '2026-10-07',
      text: `Read ${url} was the page.`,
      tags: [],
      places: [],
      others: 0,
      thumbs: [],
      photos: []
    };
  const plain = c.yesterdayBody('1981-06-20', yesterday),
    html = c.yesterdayHtml('1981-06-20', yesterday);
  assert.ok(!plain.includes('example.com'));
  assert.ok(!html.includes('example.com'));
  const linked = c.notesHtml('Read https://example.com/path', [], '…');
  assert.match(linked, /href="https:\/\/example.com\/path"/);
  assert.match(linked, /<\/a>&#8230;/);
});
