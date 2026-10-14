/** Explicitly opted-in photo descriptions. Thumbnail/EXIF work is separate and
 * never requires model consent. The model sees only the photo and fixed prompt;
 * words enter the archive only with live consent and matching immutable media. */
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { NoteRecord } from '../domain/notes.ts';
import type { Store, Item } from './store.ts';
import { imageSize } from './media.ts';
import { missing, type Objects, type Log } from './services.ts';
export const MODEL = 'claude-haiku-5-5',
  EFFORT = 'low',
  MAX_TOKENS = 2000,
  API = 'https://api.anthropic.com/v1/messages',
  MAX_BYTES = 3_750_000,
  MAX_SIDE = 8000,
  MAX_DESCRIPTION = 600,
  LEFT_FOR_NEXT = 60,
  LOCK_FOR = 960;
export const FORMATS = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export const PROMPT =
  'Describe this photo in one or two plain sentences, so it can be found by searching later: what is in it, where it seems to be, and any words you can read in it, such as signs. Answer with only those sentences: no preamble, no headings, no list of keywords or search terms.';
export type Model = (body: Item) => Promise<Item>;
export class ApiError extends Error {
  status: number;
  kind: string | null;
  about_image: boolean;
  constructor(status: number, kind: string | null, aboutImage = false) {
    super(`${status} ${kind ?? 'unknown'}${aboutImage ? ' (image)' : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.about_image = aboutImage;
  }
}
export class NoKey extends Error {
  constructor() {
    super('Description key unavailable');
    this.name = 'NoKey';
  }
}
const ERROR_KINDS = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'overloaded_error'
]);
/** Fixed HTTPS origin, redirects refused, bounded response and timeout. Neither
 * server error messages nor arbitrary error type strings escape this adapter. */
export function claudeWith(key: string, fetcher: typeof fetch = fetch, timeoutSeconds = 60): Model {
  return async (body) => {
    let response: Response;
    try {
      response = await fetcher(API, {
        method: 'POST',
        redirect: 'error',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutSeconds * 1000)
      });
    } catch {
      throw new Error('Description service unavailable');
    }
    let data: Item = {};
    try {
      const reader = response.body?.getReader(),
        parts: Uint8Array[] = [];
      let bytes = 0;
      if (reader)
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > 256 * 1024) {
              await reader.cancel();
              throw new Error('Response too large');
            }
            parts.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
      data = JSON.parse(Buffer.concat(parts).toString('utf8')) as Item;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Bad response');
    } catch {
      if (response.ok) throw new Error('Description response invalid');
    }
    if (!response.ok) {
      const error = data.error as Item | undefined;
      const kind = typeof error?.type === 'string' && ERROR_KINDS.has(error.type) ? error.type : null;
      throw new ApiError(
        response.status,
        kind,
        String(error?.message ?? '')
          .toLowerCase()
          .includes('image')
      );
    }
    return data;
  };
}
export interface SecretSource {
  get(id: string): Promise<string | undefined>;
}
/** Only the deployed runtime supplies this source. Synthetic tests supply made
 * up strings; malformed secret JSON never appears in exception diagnostics. */
export async function keyFrom(secrets: SecretSource, id: string): Promise<string> {
  let raw: string | undefined;
  try {
    raw = await secrets.get(id);
  } catch {
    throw new Error('Description key lookup failed');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw ?? '{}');
  } catch {
    throw new NoKey();
  }
  const key = value && typeof value === 'object' ? (value as Item).ANTHROPIC_API_KEY : null;
  if (typeof key !== 'string' || !key.startsWith('sk-ant-')) throw new NoKey();
  return key;
}
export function waiting(note: NoteRecord) {
  return (note.media ?? []).filter(
    (m) =>
      m.kind === 'image' &&
      FORMATS.has(String(m.type)) &&
      !('description' in m) &&
      Number(m.size ?? 0) <= MAX_BYTES &&
      String(m.key ?? '').startsWith('media/')
  );
}
export async function wordsFor(data: Buffer, type: string, model: Model): Promise<string> {
  const size = imageSize(data);
  if (data.length > MAX_BYTES || (size && Math.max(...size) > MAX_SIDE)) return '';
  let answer: Item;
  try {
    answer = await model({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: EFFORT },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: type, data: data.toString('base64') } },
            { type: 'text', text: PROMPT }
          ]
        }
      ]
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 400 &&
      error.kind === 'invalid_request_error' &&
      error.about_image
    )
      return '';
    throw error;
  }
  if (answer.stop_reason === 'refusal') return '';
  const blocks = Array.isArray(answer.content) ? (answer.content as Item[]) : [];
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join(' ')
    .trim()
    .replace(/\s+/gu, ' ');
  return Array.from(text).slice(0, MAX_DESCRIPTION).join('');
}
export interface Services {
  store: Store;
  objects: Objects;
  model: () => Promise<Model>;
  clock?: () => number;
  log?: Log;
}
export async function wanted(store: Store, user: string) {
  const p = await store.profile(user, true);
  return Boolean(p?.describe && !p.mcp_deleting);
}
export async function describe(note: NoteRecord, user: string, s: Services): Promise<number> {
  const [, day, id] = String(note.sk).split('#');
  if (!day || !id) return 0;
  let done = 0;
  for (const m of waiting(note)) {
    const n = Number(m.n),
      key = String(m.key),
      type = String(m.type),
      owner = randomUUID();
    if (!key.startsWith(`media/${user}/`)) continue;
    const now = Math.floor((s.clock ?? (() => Date.now() / 1000))());
    if (!(await s.store.claimProcessing('describe', user, day, id, n, key, type, owner, now))) {
      const lease = await s.store.processing(user, 'describe', day, id, n);
      const current = await s.store.note(user, day, id, true);
      const pending = waiting(current ?? {}).some((entry) => Number(entry.n) === n && entry.key === key);
      // An interrupted invocation keeps its lease until expiry. A retry must
      // stay retryable/alarmed, never acknowledge unfinished work as success.
      if (pending && lease?.source === key && Number(lease.expires_at) > now && (await wanted(s.store, user)))
        throw new Error('Description processing lease busy');
      continue;
    }
    try {
      let data: Buffer | null = null;
      try {
        data = (await s.objects.get(key, { maxBytes: MAX_BYTES })).body;
      } catch (error) {
        if (!missing(error) && !(error instanceof RangeError)) throw error;
      }
      if (!(await wanted(s.store, user))) continue;
      const text = data ? await wordsFor(data, type, await s.model()) : '';
      if (await s.store.finishProcessing('describe', user, day, id, n, key, type, text, owner)) done++;
    } finally {
      await s.store.releaseProcessing(user, 'describe', day, id, n, owner);
    }
  }
  return done;
}
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function testImage(width = 64, height = 64): Buffer {
  if (![width, height].every((side) => Number.isInteger(side) && side >= 1 && side <= 64))
    throw new RangeError('Invalid synthetic image dimensions');
  const chunk = (type: string, body: Buffer) => {
    const named = Buffer.concat([Buffer.from(type), body]),
      length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    crc.writeUInt32BE(crc32(named));
    return Buffer.concat([length, named, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (1 + width * 3) + 1 + x * 3;
      rows[at] = 31;
      rows[at + 1] = 79;
      rows[at + 2] = 200;
    }
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
export async function check(model: Model): Promise<Item> {
  try {
    return { ok: true, words: await wordsFor(testImage(), 'image/png', model) };
  } catch (error) {
    if (error instanceof ApiError)
      return { ok: false, status: error.status, error: error.kind, about_image: error.about_image };
    throw error;
  }
}
