import assert from 'node:assert/strict';
import test from 'node:test';
import { addingTag, found, isTag, line, removingTag, spans, tagName, togglingTag } from '../../packages/domain/tags.ts';

test('the tag row adds a tag at the end of the line, once, and only a real tag', () => {
  assert.equal(addingTag('', 'walks'), '#walks ');
  assert.equal(addingTag('Coffee on the porch  \n', 'walks'), 'Coffee on the porch #walks');
  assert.equal(addingTag('Out with the #Walks crew', 'walks'), 'Out with the #Walks crew');
  assert.equal(addingTag('Coffee', '2026'), 'Coffee');
});

test('a second tap takes every #tag for it out, with the space beside it', () => {
  assert.equal(removingTag('Coffee #walks', 'walks'), 'Coffee');
  assert.equal(removingTag('#walks at the #cabin, #Walks again', 'walks'), 'at the #cabin, again');
  assert.equal(removingTag('Café #café #cafe', 'cafe'), 'Café');
  // Offsets are code points: an emoji before the tag keeps its place.
  assert.equal(removingTag('🌲 Hike #walks #cabin', 'walks'), '🌲 Hike #cabin');
  assert.equal(togglingTag(togglingTag('Coffee', 'walks'), 'walks'), 'Coffee');
});

test('letters in any script make a tag, lowercased, with their marks', () => {
  assert.deepEqual(found('#שלום עולם, #Москва и #Αθήνα'), ['שלום', 'москва', 'αθήνα']);
  assert.deepEqual(found('#東京 #東京2026 #القاهرة #한국'), ['東京', '東京2026', 'القاهرة', '한국']);
  // Combining marks stay in the word: niqqud, a virama, Thai vowels.
  assert.deepEqual(found('#שָׁלוֹם #नमस्ते #हिन्दी #สวัสดี'), ['שָׁלוֹם', 'नमस्ते', 'हिन्दी', 'สวัสดี']);
  assert.deepEqual(spans('#नमस्ते!'), [[0, 7, 'नमस्ते']]);
  // A joiner inside a word is part of its spelling (Persian), never at its end.
  assert.deepEqual(found('#می\u200cخواهم #a\u200d'), ['می\u200cخواهم', 'a']);
  assert.deepEqual(found('#Москва-2026 #東京-旅行'), ['москва-2026', '東京-旅行']);
  // Composed, whatever the keyboard sent.
  assert.deepEqual(found('#한'), ['한']);
});

test('a tag with a-z letters keeps exactly the legacy tag and span', () => {
  assert.deepEqual(found('#café #Mañana #ok #straße #İstanbul'), ['cafe', 'manana', 'ok', 'strae', 'istanbul']);
  assert.deepEqual(spans('#Tokyo東京 #東京tokyo'), [
    [0, 8, 'tokyo'],
    [9, 17, 'tokyo']
  ]);
  // Read in full it has a-z letters after the mark, so it stays no tag.
  assert.deepEqual(found('#Σ\u0301Dö32'), []);
  // Numbers alone are still no tag, in any script.
  assert.deepEqual(found('PR #31, #2016, #١٢٣ and #２０２６'), []);
});

test('a tag in any script keeps 50 code points, never cut inside a letter', () => {
  const [long] = found('#' + '東'.repeat(60));
  assert.equal(Array.from(long!).length, 50);
  const source = 'नमस्ते'.repeat(10),
    [hindi] = found('#' + source);
  assert.ok(Array.from(hindi!).length <= 50 && source.startsWith(hindi!));
  // What it leaves off starts with a letter, not the marks of its last one.
  assert.match(source.slice(hindi!.length), /^\p{L}/u);
  assert.equal(isTag(hindi), true);
});

test('names become tags as hashtags do, and only real tags pass', () => {
  assert.equal(tagName('Москва'), 'москва');
  assert.equal(tagName('東京 旅行'), '東京-旅行');
  assert.equal(tagName('Maine 2016'), 'maine-2016');
  assert.equal(tagName('#Running'.slice(1)), 'running');
  assert.equal(line(['東京', 'Maine 2016', 'Москва', '2016']), '#東京 #maine-2016 #москва');
  for (const tag of ['maine-2016', 'cafe', 'москва', '東京', 'שלום', 'नमस्ते']) assert.equal(isTag(tag), true, tag);
  for (const tag of ['Running', 'Москва', 'café', '2016', '-abc', 'a--b', '', 'x'.repeat(51), 3])
    assert.equal(isTag(tag), false, String(tag));
  // The tag row's tap works for them too.
  assert.equal(addingTag('Lunch', '東京'), 'Lunch #東京');
  assert.equal(removingTag('Lunch #東京 #cabin', '東京'), 'Lunch #cabin');
});
