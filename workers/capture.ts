import { runtimeSelfTest } from './runtime.ts';
/** Private delegated text writer: no HTTP, no mail/media/models. Every commit
 * atomically proves the live family/profile, receipt, quota and note revision. */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { digest } from '../packages/backend/auth.ts';
import {
  collect,
  fetchTitle,
  MAX_FETCHES,
  type Link,
  type TitleFetcher,
  type PageMeta
} from '../packages/backend/links.ts';
import { OAuthService, live, type OAuthRow } from '../packages/backend/oauth.ts';
import { Store } from '../packages/backend/store.ts';
import { iso } from '../packages/domain/dates.ts';
import { MAX_NOTE } from '../packages/domain/notes.ts';
import { found } from '../packages/domain/tags.ts';
import { computeVersion } from '../packages/domain/version.ts';
import { codePointLength, pythonTrim } from '../packages/domain/unicode.ts';
import { Reader, type ReaderContext, type ReaderStore } from '../server/mcp/reader.ts';
import { TOOLS, WRITE_TOOLS } from '../server/mcp/contract.ts';
import {
  failure,
  fingerprint,
  object,
  validate,
  ToolError,
  type Arguments,
  type SafeLog
} from '../server/mcp/common.ts';
export interface CaptureStore extends ReaderStore {
  captureCommit(
    note: OAuthRow,
    old: OAuthRow | null,
    receipt: OAuthRow,
    audit: OAuthRow,
    rate: OAuthRow,
    previous: OAuthRow | null,
    family: OAuthRow,
    now: number
  ): Promise<boolean>;
}
export interface CaptureContext extends ReaderContext {
  store: CaptureStore;
}
export interface CaptureOptions {
  fetchTitle?: TitleFetcher;
  log?: SafeLog;
}
const FIELDS = [
  'pk',
  'sk',
  'text',
  'source',
  'author',
  'client',
  'client_id',
  'connection',
  'on_behalf_of',
  'written_at',
  'tz',
  'version',
  'tags',
  'links',
  'updated_at',
  'revision'
];
export async function writeCapture(
  context: CaptureContext,
  family: OAuthRow,
  name: string,
  args: Arguments,
  options: CaptureOptions = {}
): Promise<OAuthRow> {
  if (!String(family.scope).split(/\s+/).includes('notes:write'))
    throw new ToolError('scope_required', 'Reconnect and explicitly approve adding agent notes.');
  const uid = String(family.user_id),
    fid = String(family.id),
    key = 'CAPTURE#' + fid + '#' + digest(String(args.idempotency_key)),
    hash = fingerprint({ tool: name, arguments: args }),
    reader = await Reader.create(context, family),
    titles = new Map<string, PageMeta | null>();
  const titleOnce: TitleFetcher = async (url) => {
    if (!titles.has(url)) {
      if (titles.size >= MAX_FETCHES) return null;
      let title: PageMeta | null = null;
      try {
        title = await (options.fetchTitle ?? fetchTitle)(url);
      } catch {
        /* A title never holds a note. */
      }
      titles.set(url, title);
    }
    return titles.get(url) ?? null;
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const receipt = await context.store.mcpGet('USER#' + uid, key);
    if (live(receipt, context.now)) {
      if (receipt.request_hash !== hash)
        throw new ToolError(
          'duplicate_idempotency_key',
          'Use a new key for a different operation; reuse the original key only for an exact retry.'
        );
      return { note: JSON.parse(String(receipt.result)), replayed: true };
    }
    const day = reader.day(args.date ?? reader.today);
    let text = pythonTrim(String(args.text).replace(/\r\n/g, '\n')),
      old: OAuthRow | null = null;
    if (!text) throw new ToolError('invalid_arguments', 'Write some note text.');
    if (name === 'notes_append') {
      old = await reader.note(args);
      if (old.author !== 'assistant' || old.connection !== fid || old.client_id !== family.client_id)
        throw new ToolError(
          'forbidden_not_author',
          'Append only to a note created by this same connection; create a new note for anything else.'
        );
      text = String(old.text ?? '') + '\n\n' + text;
    }
    if (codePointLength(text) > MAX_NOTE)
      throw new ToolError('too_long', 'A note can have at most 20,000 characters; create another note.');
    const note: OAuthRow = old
      ? Object.fromEntries(FIELDS.filter((k) => Object.hasOwn(old, k)).map((k) => [k, old![k]]))
      : {
          pk: 'USER#' + uid,
          sk: `NOTE#${day}#a-${randomUUID().replace(/-/g, '')}`,
          source: 'agent',
          author: 'assistant',
          client: family.client_name,
          client_id: family.client_id,
          connection: fid,
          on_behalf_of: uid,
          written_at: iso(context.now),
          tz: reader.profile.tz,
          version: computeVersion(reader.birthday, day).toString()
        };
    Object.assign(note, {
      text,
      tags: found(text),
      links: await collect(text, { keep: old?.links as Link[] | undefined, fetch: titleOnce }),
      revision: Number(old?.revision ?? 0) + 1
    });
    if (old) note.updated_at = iso(context.now);
    const rateKey = `WRITERATE#${name}#${Math.floor(context.now / 86400)}`,
      previous = await context.store.mcpGet('MCPMETA#' + uid, rateKey),
      count = Number(previous?.n ?? 0),
      cap = name === 'notes_create' ? 20 : 50;
    if (count >= cap)
      throw new ToolError(
        'rate_limited',
        'Try again after this UTC day ends; exact retries of completed writes are still safe.'
      );
    const rate = {
        pk: 'MCPMETA#' + uid,
        sk: rateKey,
        n: count + 1,
        revision: Number(previous?.revision ?? 0) + 1,
        expires_at: (Math.floor(context.now / 86400) + 2) * 86400
      },
      shown = reader.view({ ...old, ...note }, true);
    const newReceipt = {
        pk: 'USER#' + uid,
        sk: key,
        request_hash: hash,
        result: JSON.stringify(shown),
        expires_at: context.now + 86400
      },
      audit = {
        pk: 'MCPMETA#' + uid,
        sk: `LOG#${String(context.now).padStart(12, '0')}#${randomUUID().replace(/-/g, '')}`,
        at: context.now,
        tool: name,
        outcome: 'ok',
        connection: fid,
        client: family.client_name,
        date: day,
        note_id: String(note.sk).split('#').slice(2).join('#'),
        expires_at: context.now + 14 * 86400
      };
    if (await context.store.captureCommit(note, old, newReceipt, audit, rate, previous, family, context.now))
      return { note: shown, replayed: false };
    const current = await context.store.mcpGet('OAUTHFAMILY#' + fid),
      profile = await context.store.mcpProfile(uid);
    if (
      !live(current, context.now) ||
      !profile ||
      profile.mcp_deleting ||
      current.revision !== family.revision ||
      !String(current.scope).split(/\s+/).includes('notes:write')
    )
      throw new ToolError('scope_required', 'This connection changed or was disconnected; reconnect before writing.');
  }
  throw new ToolError('busy', 'Try again shortly with exactly the same idempotency_key and arguments.');
}
export async function captureNote(
  event: unknown,
  context: CaptureContext,
  options: CaptureOptions = {}
): Promise<OAuthRow> {
  let uid = 'unknown';
  try {
    const input = object(event) ? event : {},
      token = input.token ?? '',
      name = input.tool,
      args = input.arguments ?? {};
    if (typeof token !== 'string' || codePointLength(token) > 256)
      throw new ToolError('scope_required', 'Reconnect before writing.');
    const family = await new OAuthService(context).bearer(token);
    if (!family) throw new ToolError('scope_required', 'Reconnect before writing.');
    uid = String(family.user_id);
    if (typeof name !== 'string' || !WRITE_TOOLS.has(name))
      throw new ToolError('unknown_tool', 'Only create and append are supported.');
    validate(args, TOOLS.find((t) => t.name === name)!.inputSchema);
    return await writeCapture(context, family, name, args, options);
  } catch (error) {
    if (error instanceof ToolError) return { error: error.code, next_step: error.nextStep };
    failure(context.now, uid, options.log);
    return {
      error: 'temporarily_unavailable',
      next_step: 'Try again shortly with exactly the same idempotency_key and arguments.'
    };
  }
}
let runtimeStore: Store | undefined;
export async function handler(event: unknown): Promise<OAuthRow> {
  if (runtimeSelfTest(event)) return runtimeSelfTest(event)!;
  runtimeStore ??= new Store(
    DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' }), {
      marshallOptions: { removeUndefinedValues: true }
    }),
    process.env.TABLE ?? process.env.TABLE_NAME ?? ''
  );
  return captureNote(event, {
    store: runtimeStore,
    origin: process.env.WEB_ORIGIN ?? '',
    now: Math.floor(Date.now() / 1000)
  });
}
