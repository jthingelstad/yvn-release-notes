/** Shared web/MCP search: AND terms, quoted phrases, names and already
 * available descriptions/transcripts. Search never triggers processing. */
import { placeLabel, type NoteRecord } from './notes.ts';
import { fold, pythonTrim } from './unicode.ts';
export { fold } from './unicode.ts';
export const MAX_QUERY = 200,
  SEARCH_DAYS = 100;
const terms =
  /"([^"]*)"|([^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+)/g;
export function searchTerms(query: string): string[] {
  const found: string[] = [];
  for (const match of query.matchAll(terms)) {
    const term = pythonTrim(fold(match[1] || (match[2] || '').replace(/^"+|"+$/g, '')));
    if (term) found.push(term);
    if (found.length === 10) break;
  }
  return found;
}
export function searchedText(note: NoteRecord): string {
  const words = [note.text || ''];
  for (const media of note.media || [])
    for (const key of ['transcript', 'description']) words.push(String(media[key] || ''));
  if (note.place) words.push(placeLabel(note.place));
  for (const link of note.links || []) words.push(String(link.title || ''));
  return fold(words.join('\n'));
}
