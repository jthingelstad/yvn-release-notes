import { reject } from '../../packages/backend/sessions.ts';
import { oauthResponse } from '../../packages/backend/oauth.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import { validDay, localDay } from '../../packages/domain/dates.ts';
import { codePointLength, pythonTrim } from '../../packages/domain/unicode.ts';
import { MAX_NOTE } from '../../packages/domain/notes.ts';
export const json = (value: unknown, status = 200, headers: HeadersInit = {}) => oauthResponse(status, value, headers);
export async function body(request: Request): Promise<Item> {
  if (Number(request.headers.get('content-length') ?? 0) > 64 * 1024) reject(413, 'too-large');
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 64 * 1024) {
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
  const text = pythonTrim(raw.replace(/\r\n/g, '\n'));
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
