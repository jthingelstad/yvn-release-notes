// Tags as the pages handle them (docs/TAGS.md): each a name, as written, and a
// key that matches every spelling ("Road Trip" is road-trip). The rules are
// the server's own (packages/domain/tags.ts); this is what the tags field
// and a note's chips do with them.
import {
  MAX_TAG,
  MAX_TAGS,
  mergeTags,
  removingTag,
  spelling,
  textTags,
  type Tag,
  type TagRefusal
} from '../../../packages/domain/tags.ts';

export type { Tag };

/** What the tags field says when it won't take a tag (Jamie's call 4). */
export const TAG_SAY: Record<TagRefusal, string> = {
  list: 'That didn’t save. Try again.',
  text: 'That didn’t save. Try again.',
  many: `That’s ${MAX_TAGS} tags, the most one can have. Take one off first.`,
  break: 'A tag is one line.',
  comma: 'A tag has no commas. Add each tag on its own.',
  long: `A tag is at most ${MAX_TAG} characters.`,
  empty: 'A tag needs a letter, a number or an emoji.'
};
export const isRefusal = (reason: unknown): reason is TagRefusal =>
  typeof reason === 'string' && Object.hasOwn(TAG_SAY, reason);

/** A tag typed into the field, added to `tags`: the list with it, or why
 * not. A tag already there, by any spelling, leaves the list as it was. */
export function adding(
  tags: readonly Tag[],
  typed: string
): { tags: Tag[]; added: Tag | null } | { refused: TagRefusal } {
  const tag = spelling(typed);
  if (typeof tag === 'string') return { refused: tag };
  if (tags.some((t) => t.key === tag.key)) return { tags: [...tags], added: null };
  if (tags.length >= MAX_TAGS) return { refused: 'many' };
  return { tags: [...tags, tag], added: tag };
}

/** The tags an answer gives, its keys beside their names. */
export const named = (keys?: readonly string[] | null, names?: readonly string[] | null): Tag[] =>
  mergeTags((keys ?? []).map((key, i) => ({ key, name: names?.[i] || key })));

/** A note's chips: the tags from its field, then its #words, as the server
 * keeps them. */
export const noteChips = (text: string, field: readonly Tag[]): Tag[] => mergeTags(field, textTags(text));

/** The tags a note has that its words don't: the ones its field gave it,
 * which show under it. */
export function fieldOnly(text: string, tags: readonly Tag[]): Tag[] {
  const typed = new Set(textTags(text).map((t) => t.key));
  return tags.filter((t) => !typed.has(t.key));
}

/** Taking a tag off a note (Jamie's call 1): its #words leave the text too,
 * and it leaves the field. */
export function removingNoteTag(text: string, field: readonly Tag[], key: string): { text: string; field: Tag[] } {
  return { text: removingTag(text, key), field: field.filter((t) => t.key !== key) };
}

/** A key to its name, from lists the latest of which comes last. */
export function nameBook(...lists: readonly (readonly Tag[])[]): Map<string, string> {
  const book = new Map<string, string>();
  for (const list of lists) for (const t of list) book.set(t.key, t.name);
  return book;
}

/** Names as one line, "Road Trip, lake". */
export const tagLine = (tags: readonly Tag[]): string => tags.map((t) => t.name).join(', ');
