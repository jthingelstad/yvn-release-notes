import { reject } from '../../packages/backend/sessions.ts';
import { oauthResponse } from '../../packages/backend/oauth.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import { validDay, localDay } from '../../packages/domain/dates.ts';
import { codePointLength, pythonTrim } from '../../packages/domain/unicode.ts';
import { MAX_NOTE, noteWords } from '../../packages/domain/notes.ts';
import { MAX_QUERY, searchTerms } from '../../packages/domain/search.ts';
export const json = (value: unknown, status = 200, headers: HeadersInit = {}) => oauthResponse(status, value, headers);
/** Largest JSON body a valid request can need. Note text is limited to MAX_NOTE code points after
 * trimming, and JSON.stringify spends at most 6 bytes on one code point (a \u00XX control escape;
 * astral characters are 4 raw UTF-8 bytes), so a full note plus its envelope always fits. */
export const MAX_BODY = MAX_NOTE * 6 + 16 * 1024;
/** The JSON body, at most `max` bytes (MAX_BODY unless a route needs more). */
export async function body(request: Request, max = MAX_BODY): Promise<Item> {
  if (Number(request.headers.get('content-length') ?? 0) > max) reject(413, 'too-large');
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > max) {
          await reader.cancel();
          reject(413, 'too-large');
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) || '{}');
  } catch {
    reject(400, 'bad-json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) reject(400, 'bad-json');
  return parsed as Item;
}
/** A search's words ({q}, from a POST body, never a URL), as its terms. */
export function searchFrom(b: Item): string[] {
  const q = b.q;
  if (typeof q !== 'string' || !pythonTrim(q)) reject(400, 'query');
  if (codePointLength(q) > MAX_QUERY) reject(400, 'query-too-long');
  const terms = searchTerms(q);
  if (!terms.length) reject(400, 'query');
  return terms;
}
export function trustedViewer(request: Request): string {
  const raw = request.headers.get('cloudfront-viewer-address') ?? '';
  return raw.includes(':') ? raw.slice(0, raw.lastIndexOf(':')).replace(/^\[|\]$/g, '') : '';
}
export const dayFrom = (p: Item, value: unknown, now: number): string => {
  if (
    typeof value !== 'string' ||
    !validDay(value) ||
    value < String(p.birthday) ||
    value > localDay(now, String(p.tz))
  )
    reject(400, 'date');
  return value;
};
export const textFrom = (b: Item, empty = false): string => {
  const raw = b.text ?? (empty ? '' : null);
  if (typeof raw !== 'string') reject(400, 'text');
  const text = noteWords(raw);
  if (!text && !empty) reject(400, 'text');
  if (codePointLength(text) > MAX_NOTE) reject(400, 'too-long');
  return text;
};
export const pageLimit = (params: URLSearchParams): number => {
  const raw = params.get('limit') || '30';
  if (!/^[+-]?[0-9]+$/.test(raw)) reject(400, 'limit');
  return Math.max(1, Math.min(Number(raw), 100));
};
export const dateOf = (n: Item): string => String(n.sk).split('#')[1]!;
