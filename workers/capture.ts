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
import { agentUpcomingView, Reader, type ReaderContext, type ReaderStore } from '../server/mcp/reader.ts';
import { TOOLS, UPCOMING_TOOLS, WRITE_TOOLS } from '../server/mcp/contract.ts';
import { ApiError } from '../packages/backend/sessions.ts';
import { search, type City } from '../packages/backend/places.ts';
import { prepareUpcomingBatch, type UpcomingBatch, type UpcomingChange } from '../packages/backend/upcoming.ts';
import { occurrence, type UpcomingEntry } from '../packages/domain/upcoming.ts';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import {
  failure,
  fingerprint,
  object,
  validate,
  ToolError,
  type Arguments,
  type SafeLog
} from '../server/mcp/common.ts';
type Ops = NonNullable<TransactWriteCommandInput['TransactItems']>;
export interface CaptureStore extends ReaderStore {
  upcomingBatch(uid: string, changes: readonly UpcomingChange[], extra: Ops): Promise<{ ok: boolean; applied: number }>;
  agentProof(family: OAuthRow, now: number, scope: string): Ops;
  familyProof(family: OAuthRow, now: number, scope: string): Ops;
  agentReceipts(receipt: OAuthRow, audit: OAuthRow, rate: OAuthRow, previous: OAuthRow | null, now: number): Ops;
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
  /** City search for a destination written as text; Open-Meteo by default. */
  geocode?: (q: string) => Promise<City[]>;
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
/** What each refusal means to an agent, by the API's own error codes. */
const HINTS: Record<string, string> = {
  'upcoming-fields': 'Use only the fields in the schema; an id needs its revision, and a new entry has neither.',
  'upcoming-kind': 'kind is birthday, anniversary, trip or event.',
  'upcoming-title': 'Give a title of up to 120 characters on one line.',
  'upcoming-tag': 'A tag is one word of letters, numbers and hyphens, up to 50 characters.',
  'upcoming-date': 'A birthday or anniversary date is MM-DD; a trip or event date is YYYY-MM-DD.',
  'upcoming-year': 'A year goes with a birthday or anniversary and is not after today.',
  'upcoming-end': 'A trip has an end_date on or after its date; other kinds have none.',
  'upcoming-place':
    'A trip needs a destination the city search knows, like "Zürich" or "Paris, Texas"; other kinds have none.',
  'upcoming-email': 'email is true or false.',
  'upcoming-reminders': 'reminders are up to six different days from 0 to 365.',
  'upcoming-limit': 'The account can hold 200 saved dates.',
  'upcoming-batch': 'Send at most 50 entries per call.'
};
/** Up to 50 Upcoming dates added, changed or removed as one transaction with
 * the same receipt, audit, daily count and live-grant proof as a note. */
export async function writeUpcoming(
  context: CaptureContext,
  family: OAuthRow,
  name: string,
  args: Arguments
): Promise<OAuthRow> {
  if (!String(family.scope).split(/\s+/).includes('upcoming'))
    throw new ToolError('scope_required', 'Reconnect and approve reading and changing Upcoming dates.');
  const uid = String(family.user_id),
    fid = String(family.id),
    key = 'CAPTURE#' + fid + '#' + digest(String(args.idempotency_key)),
    hash = fingerprint({ tool: name, arguments: args }),
    reader = await Reader.create(context, family),
    entries = args.entries as unknown[];
  if (entries.some((entry) => !object(entry)))
    throw new ToolError('invalid_arguments', 'Each entry is an object with the fields in the schema.');
  const rows = entries as Arguments[],
    batch: UpcomingBatch =
      name === 'upcoming_save'
        ? {
            add: rows.filter((e) => !Object.hasOwn(e, 'id')),
            change: rows.filter((e) => Object.hasOwn(e, 'id')),
            remove: []
          }
        : { add: [], change: [], remove: rows };
  const indexOf = (list: string, index: number) =>
    rows.indexOf((batch as unknown as Record<string, Arguments[]>)[list]![index]!);
  for (let attempt = 0; attempt < 5; attempt++) {
    const receipt = await context.store.mcpGet('USER#' + uid, key);
    if (live(receipt, context.now) && !args.dry_run) {
      if (receipt.request_hash !== hash)
        throw new ToolError(
          'duplicate_idempotency_key',
          'Use a new key for a different operation; reuse the original key only for an exact retry.'
        );
      return { ...(JSON.parse(String(receipt.result)) as OAuthRow), replayed: true };
    }
    const existing = await context.store.upcomingEntries(uid);
    let changes: UpcomingChange[];
    try {
      changes = (await prepareUpcomingBatch(batch, existing, reader.today, iso(context.now), context.geocode ?? search))
        .changes;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const where =
        typeof error.extra.list === 'string' && typeof error.extra.index === 'number'
          ? ` (entries[${indexOf(error.extra.list, error.extra.index)}])`
          : '';
      if (error.error === 'places-failed')
        throw new ToolError('temporarily_unavailable', 'The city search is unavailable; try again shortly.');
      if (error.error === 'upcoming-changed')
        throw new ToolError('conflict', `That date changed since you listed it${where}; read upcoming_list again.`);
      if (error.error === 'upcoming-missing')
        throw new ToolError('not_found', `No saved date has that id${where}; read upcoming_list for current ids.`);
      throw new ToolError('invalid_arguments', (HINTS[error.error] ?? error.error) + where);
    }
    const shown: OAuthRow =
      name === 'upcoming_save'
        ? {
            saved: changes.map((c) =>
              agentUpcomingView({ ...(c.next as UpcomingEntry), occurrence: occurrence(c.next!, reader.today) })
            )
          }
        : { removed: changes.length };
    const flag = name === 'upcoming_save' ? { dry_run: false } : {};
    if (args.dry_run) return { ...shown, dry_run: true, replayed: false };
    const rateKey = `WRITERATE#upcoming#${Math.floor(context.now / 86400)}`,
      previous = await context.store.mcpGet('MCPMETA#' + uid, rateKey),
      count = Number(previous?.n ?? 0);
    if (count >= 50)
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
      newReceipt = {
        pk: 'USER#' + uid,
        sk: key,
        request_hash: hash,
        result: JSON.stringify({ ...shown, ...flag }),
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
        count: changes.length,
        expires_at: context.now + 14 * 86400
      };
    const outcome = await context.store.upcomingBatch(uid, changes, [
      ...context.store.familyProof(family, context.now, 'upcoming'),
      ...context.store.agentReceipts(newReceipt, audit, rate, previous, context.now)
    ]);
    if (outcome.ok) return { ...shown, ...flag, replayed: false };
    const current = await context.store.mcpGet('OAUTHFAMILY#' + fid),
      profile = await context.store.mcpProfile(uid);
    if (
      !live(current, context.now) ||
      !profile ||
      profile.mcp_deleting ||
      current.revision !== family.revision ||
      !String(current.scope).split(/\s+/).includes('upcoming')
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
      throw new ToolError('unknown_tool', 'Only the write tools are supported here.');
    validate(args, TOOLS.find((t) => t.name === name)!.inputSchema);
    return await (UPCOMING_TOOLS.has(name)
      ? writeUpcoming(context, family, name, args)
      : writeCapture(context, family, name, args, options));
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
