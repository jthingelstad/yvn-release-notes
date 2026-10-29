import assert from 'node:assert/strict';
import test from 'node:test';
import { addingTag, removingTag, togglingTag } from '../../packages/domain/tags.ts';

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
