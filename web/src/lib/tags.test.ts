// The tags field's rules (Jamie's call 4) and a note's chips, whose removal
// takes the #word out of the text too (call 1).
import { describe, expect, it } from 'vitest';
import { adding, fieldOnly, isRefusal, named, nameBook, noteChips, removingNoteTag, TAG_SAY, tagLine } from './tags.ts';

const tag = (name: string, key = name.toLowerCase().replace(/ /g, '-')) => ({ key, name });

describe('adding a tag', () => {
  it('takes a name with spaces and emoji, without its leading #', () => {
    expect(adding([], 'Road Trip')).toEqual({ tags: [tag('Road Trip')], added: tag('Road Trip') });
    expect(adding([], '#lake')).toEqual({ tags: [tag('lake')], added: tag('lake') });
    const r = adding([], '  🚗   Lake  ');
    expect('added' in r && r.added?.name).toBe('🚗 Lake');
  });

  it('leaves a tag already there, by any spelling, as it is', () => {
    expect(adding([tag('Road Trip')], 'road trip')).toEqual({ tags: [tag('Road Trip')], added: null });
    expect(adding([tag('Road Trip')], '#ROAD-TRIP')).toEqual({ tags: [tag('Road Trip')], added: null });
  });

  it('refuses a tag over 50 characters, commas, line breaks and nothing to say', () => {
    expect(adding([], 'x'.repeat(50))).toHaveProperty('added');
    expect(adding([], 'x'.repeat(51))).toEqual({ refused: 'long' });
    expect(adding([], 'lake, cabin')).toEqual({ refused: 'comma' });
    expect(adding([], 'lake\ncabin')).toEqual({ refused: 'break' });
    expect(adding([], '#')).toEqual({ refused: 'empty' });
    expect(adding([], '!!!')).toEqual({ refused: 'empty' });
  });

  it('refuses a 21st tag, but not one already there', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => tag(`t${i}`));
    expect(adding(twenty, 'one more')).toEqual({ refused: 'many' });
    expect(adding(twenty, 'T3')).toEqual({ tags: twenty, added: null });
    expect(adding(twenty.slice(1), 'one more')).toHaveProperty('added', tag('one more'));
  });

  it('says why in plain words', () => {
    expect(TAG_SAY.long).toBe('A tag is at most 50 characters.');
    expect(TAG_SAY.many).toBe('That’s 20 tags, the most one can have. Take one off first.');
    expect(TAG_SAY.comma).toBe('A tag has no commas. Add each tag on its own.');
    expect(TAG_SAY.break).toBe('A tag is one line.');
    expect(isRefusal('long')).toBe(true);
    expect(isRefusal('toString')).toBe(false);
    expect(isRefusal(undefined)).toBe(false);
  });
});

describe('a note’s chips', () => {
  it('are its field’s tags, then its #words, each once', () => {
    expect(noteChips('Out at the #lake with #Cabin', [tag('Road Trip'), tag('Lake')])).toEqual([
      tag('Road Trip'),
      tag('Lake'),
      tag('Cabin')
    ]);
    expect(noteChips('', [])).toEqual([]);
  });

  it('show under a note only where its words don’t carry them', () => {
    const tags = named(['road-trip', 'lake'], ['Road Trip', 'lake']);
    expect(fieldOnly('Out at the #lake', tags)).toEqual([tag('Road Trip')]);
    expect(fieldOnly('Out at the #Lake', [tag('lake')])).toEqual([]);
    expect(fieldOnly('', tags)).toEqual(tags);
  });

  it('take the #word out of the text when one is removed', () => {
    expect(removingNoteTag('Out at the #lake today', [tag('Road Trip')], 'lake')).toEqual({
      text: 'Out at the today',
      field: [tag('Road Trip')]
    });
    expect(removingNoteTag('#lake first, then #Lake again', [], 'lake').text).toBe('first, then again');
  });

  it('leave the text alone when the tag came from the field', () => {
    expect(removingNoteTag('Out at the #lake', [tag('Road Trip')], 'road-trip')).toEqual({
      text: 'Out at the #lake',
      field: []
    });
  });
});

describe('names', () => {
  it('pairs keys with their names, the key standing in for a missing one', () => {
    expect(named(['road-trip', 'lake'], ['Road Trip'])).toEqual([tag('Road Trip'), tag('lake')]);
    expect(named(undefined, undefined)).toEqual([]);
  });

  it('reads as one line, and the latest spelling wins', () => {
    expect(tagLine([tag('Road Trip'), tag('lake')])).toBe('Road Trip, lake');
    expect(nameBook([tag('road trip', 'road-trip')], [tag('Road Trip')]).get('road-trip')).toBe('Road Trip');
  });
});
