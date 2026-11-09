import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  addingTag,
  fieldTags,
  found,
  isTag,
  line,
  mergeTags,
  noteTags,
  removingTag,
  spans,
  spelling,
  storedTags,
  tagFields,
  tagKey,
  tagName,
  tagTotals,
  textTags,
  togglingTag
} from '../../packages/domain/tags.ts';

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
  // Since 2026-11-08 one that mixes in another script keeps both parts.
  assert.deepEqual(spans('#Tokyo東京 #東京tokyo'), [
    [0, 8, 'tokyo東京'],
    [9, 17, '東京tokyo']
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
  // A tags field takes numbers alone, so 2016 is a key, though #2016 in text is no tag.
  assert.equal(isTag('2016'), true);
  for (const tag of ['Running', 'Москва', 'café', '-abc', 'a--b', '', 'x'.repeat(51), 3])
    assert.equal(isTag(tag), false, String(tag));
  // The tag row's tap works for them too.
  assert.equal(addingTag('Lunch', '東京'), 'Lunch #東京');
  assert.equal(removingTag('Lunch #東京 #cabin', '東京'), 'Lunch #cabin');
});

const vectors = JSON.parse(readFileSync(new URL('../../contracts/tag-vectors.json', import.meta.url), 'utf8')) as {
  names: { typed: string; name: string; key: string }[];
  refused: { typed: string; reason: string }[];
  text: { text: string; tags: { key: string; name: string }[] }[];
};

test('the shared vectors are what the rules say (node --import tsx tools/export-tag-vectors.ts)', () => {
  for (const v of vectors.names) {
    assert.deepEqual(spelling(v.typed), { key: v.key, name: v.name }, v.typed);
    assert.equal(tagKey(v.key), v.key, 'a key is its own key');
    assert.equal(isTag(v.key), true, v.key);
  }
  for (const v of vectors.refused) assert.equal(spelling(v.typed), v.reason, v.typed);
  for (const v of vectors.text) assert.deepEqual(textTags(v.text), v.tags, v.text);
});

test('one tag, however it is typed: case, spaces, hyphens and underscores, accents', () => {
  const keys = ['Road Trip', 'road trip', 'road-trip', 'Road_Trip', '#ROAD  TRIP'].map(
    (n) => (spelling(n) as { key: string }).key
  );
  assert.deepEqual([...new Set(keys)], ['road-trip']);
  assert.equal(tagKey('Café'), tagKey('cafe'));
  // Every key from before stays: Latin letters alone are the legacy slug.
  for (const name of ['Maine 2016', 'big-green-egg', 'Café', 'Mañana', 'İstanbul'])
    assert.equal(tagKey(name), tagName(name));
  // Emoji are part of a tag, and their presentation isn't.
  assert.notEqual(tagKey('Road Trip 🚗'), tagKey('Road Trip'));
  assert.equal(tagKey('🏖\ufe0f beach'), tagKey('🏖 Beach'));
});

test('a tags field takes names, each once, and refuses what it would have to change', () => {
  assert.deepEqual(fieldTags(['Road Trip', 'road-trip', ' lake ']), [
    { key: 'road-trip', name: 'Road Trip' },
    { key: 'lake', name: 'lake' }
  ]);
  assert.deepEqual(fieldTags('lake'), { refused: 'list', at: -1 });
  assert.deepEqual(fieldTags(['ok', 7]), { refused: 'text', at: 1 });
  assert.deepEqual(fieldTags(['ok', 'a, b']), { refused: 'comma', at: 1 });
  assert.deepEqual(fieldTags(Array.from({ length: 21 }, (_, i) => `tag ${i}`)), { refused: 'many', at: 20 });
  // Twenty-one names that are twenty tags are twenty.
  assert.equal((fieldTags([...Array.from({ length: 20 }, (_, i) => `tag ${i}`), 'TAG 0']) as unknown[]).length, 20);
});

test('a note keeps its field tags through edits that change only its words', () => {
  const field = fieldTags(['Road Trip']) as { key: string; name: string }[],
    made = noteTags('Coffee at the #cabin', field);
  assert.deepEqual(made, [
    { key: 'road-trip', name: 'Road Trip' },
    { key: 'cabin', name: 'cabin' }
  ]);
  const stored = { text: 'Coffee at the #cabin', ...tagFields(made) };
  // An email reply or an old client sends words alone: the field tag stays,
  // a hashtag taken out goes, a new one comes.
  assert.deepEqual(noteTags('Coffee at the lake #Lake', null, stored), [
    { key: 'road-trip', name: 'Road Trip' },
    { key: 'lake', name: 'Lake' }
  ]);
  // A field sent is the whole list, with the text's hashtags after it.
  assert.deepEqual(noteTags('Coffee #cabin', [], stored), [{ key: 'cabin', name: 'cabin' }]);
  assert.deepEqual(tagFields([]), {});
});

test('stored tags are named by tag_names, else by their keys', () => {
  assert.deepEqual(storedTags({ tags: ['road-trip'], tag_names: ['Road Trip'] }), [
    { key: 'road-trip', name: 'Road Trip' }
  ]);
  assert.deepEqual(storedTags({ tags: ['lake'] }), [{ key: 'lake', name: 'lake' }]);
  // Every note was named by the 2026-11-08 migration: no tags stored is none.
  assert.deepEqual(storedTags({}), []);
  // An Upcoming date of before 2026-11-08 has one tag.
  assert.deepEqual(storedTags({ tag: 'maine-2016' }), [{ key: 'maine-2016', name: 'maine-2016' }]);
  assert.deepEqual(
    mergeTags(
      [{ key: 'a', name: 'A' }],
      [
        { key: 'a', name: 'a' },
        { key: 'b', name: 'b' }
      ]
    ),
    [
      { key: 'a', name: 'A' },
      { key: 'b', name: 'b' }
    ]
  );
});

test('the tag list counts notes, check-ins and Upcoming dates, named as last used', () => {
  const totals = tagTotals(
    [
      { sk: 'NOTE#2026-10-01#a', tags: ['road-trip'], tag_names: ['road trip'] },
      { sk: 'NOTE#2026-11-01#b', tags: ['road-trip', 'lake'], tag_names: ['Road Trip', 'lake'] }
    ],
    [{ tags: ['road-trip'], tag_names: ['ROAD TRIP'] }, { tag: 'maine-2016' }],
    [{ day: '2026-10-15', tags: ['lake'], tag_names: ['Lake'] }]
  );
  assert.deepEqual(totals, [
    {
      tag: 'road-trip',
      name: 'Road Trip',
      notes: 2,
      days: 2,
      first: '2026-10-01',
      last: '2026-11-01',
      upcoming: 1,
      check_ins: 0
    },
    {
      tag: 'lake',
      name: 'lake',
      notes: 1,
      days: 1,
      first: '2026-10-15',
      last: '2026-11-01',
      upcoming: 0,
      check_ins: 1
    },
    { tag: 'maine-2016', name: 'maine-2016', notes: 0, days: 0, first: null, last: null, upcoming: 1, check_ins: 0 }
  ]);
});
