/** `/v1` writes (docs/API.md), made here in the private capture function as
 * an agent's are: the MCP function's /v1 router checks the token and hands
 * on the request, and this checks it again and proves the live account and
 * token in the same transaction as the write, its 7-day receipt, its
 * content-free audit row and the account's daily count. A token writes in
 * the owner's voice (`source` api, no `author`), and changes only notes it
 * wrote itself. With `upcoming`, it lists nothing here but saves and removes
 * Upcoming dates as an agent does (workers/capture.ts, writeUpcoming): all
 * or nothing, from the revision it read, with a dry run that writes
 * nothing. */
import { randomUUID } from 'node:crypto';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { digest } from '../packages/backend/auth.ts';
import {
  collect,
  fetchTitle,
  MAX_FETCHES,
  type Link,
  type PageMeta,
  type TitleFetcher
} from '../packages/backend/links.ts';
import { live, type OAuthRow } from '../packages/backend/oauth.ts';
import { activityLog, again, badgeEvents, recordActivity, upcomingEvents } from '../packages/backend/activity.ts';
import { addedEvents, earnedBy, unlockedBy } from '../packages/backend/badges.ts';
import { keys as mediaKeys } from '../packages/backend/media.ts';
import { search } from '../packages/backend/places.ts';
import { safeLog } from '../packages/backend/services.ts';
import { ApiError } from '../packages/backend/sessions.ts';
import { pinnedTags, pinsOf, tagRow, type TagRowStore } from '../packages/backend/tag-row.ts';
import {
  checkToken,
  SCOPE_REFUSALS,
  scopesOf,
  V1_LIMITS,
  V1_RECEIPT_SECONDS,
  V1_UPCOMING_MAX,
  type TokenReads
} from '../packages/backend/tokens.ts';
import {
  batchShape,
  prepareUpcomingBatch,
  UPCOMING_HINTS,
  type UpcomingBatch,
  type UpcomingChange
} from '../packages/backend/upcoming.ts';
import { iso, localDay, validDay } from '../packages/domain/dates.ts';
import { MAX_NOTE, type NoteRecord } from '../packages/domain/notes.ts';
import { found } from '../packages/domain/tags.ts';
import { occurrence, type UpcomingEntry } from '../packages/domain/upcoming.ts';
import { codePointLength, pythonTrim } from '../packages/domain/unicode.ts';
import { computeVersion } from '../packages/domain/version.ts';
import type { ActivityEvent } from '../packages/domain/activity.ts';
import type { Unlocked } from '../packages/domain/badges.ts';
import { agentUpcomingView, editRevision } from '../server/mcp/reader.ts';
import { fingerprint, object, type Arguments, type SafeLog } from '../server/mcp/common.ts';
import type { CaptureContext } from './capture.ts';

type Ops = NonNullable<TransactWriteCommandInput['TransactItems']>;

export interface ApiStore extends TokenReads, TagRowStore {
  note(uid: string, day: string, id: string, consistent?: boolean): Promise<OAuthRow | null>;
  tokenProof(token: OAuthRow, now: number, scope: string | readonly string[]): Ops;
  agentReceipts(receipt: OAuthRow, audit: OAuthRow, rate: OAuthRow, previous: OAuthRow | null, now: number): Ops;
  apiNoteCommit(
    note: OAuthRow,
    old: OAuthRow | null,
    receipt: OAuthRow,
    audit: OAuthRow,
    rate: OAuthRow,
    previous: OAuthRow | null,
    token: OAuthRow,
    now: number
  ): Promise<boolean>;
  apiNoteDelete(
    old: OAuthRow,
    receipt: OAuthRow,
    audit: OAuthRow,
    rate: OAuthRow,
    previous: OAuthRow | null,
    token: OAuthRow,
    now: number
  ): Promise<boolean>;
  setPins(user: string, pins: readonly string[], old: readonly string[] | null, extra?: Ops): Promise<boolean>;
  revokeToken(token: OAuthRow): Promise<boolean>;
}

/** The operations the router hands on, each with its body's fields. */
export const API_WRITES: Record<string, readonly string[]> = {
  'notes.create': ['text', 'date', 'written_at'],
  'notes.edit': ['date', 'id', 'text', 'revision'],
  'notes.append': ['date', 'id', 'text'],
  'notes.delete': ['date', 'id'],
  'tags.pinned': ['pinned'],
  'upcoming.batch': ['add', 'change', 'remove', 'dry_run'],
  'upcoming.delete': ['id', 'revision'],
  'token.revoke': []
};

const scopeFor = (op: string) => (op.startsWith('upcoming.') ? 'upcoming' : 'notes:write');

/** A refusal in `/v1`'s own words (docs/API.md, Errors). */
export class ApiRefusal extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly extra: OAuthRow = {}
  ) {
    super(code);
  }
}

/** What a write answers: a status and body, whether a receipt answered it,
 * and the daily count it used. */
export interface ApiAnswer {
  status: number;
  body: OAuthRow | null;
  replayed: boolean;
  limit?: { limit: number; remaining: number; reset: number };
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** Seconds until the UTC day ends, when every daily count starts again. */
export const untilUtcMidnight = (now: number): number => (Math.floor(now / 86400) + 1) * 86400 - now;

function text(args: Arguments): string {
  if (typeof args.text !== 'string') throw new ApiRefusal('text_required', 'Send the note as text.', { field: 'text' });
  const value = pythonTrim(args.text.replace(/\r\n/g, '\n'));
  if (!value) throw new ApiRefusal('text_required', 'Write some text for the note.', { field: 'text' });
  return value;
}
function tooLong(value: string): void {
  if (codePointLength(value) > MAX_NOTE)
    throw new ApiRefusal('too_large', 'A note can have at most 20,000 characters; send another note for the rest.', {
      field: 'text'
    });
}
function shape(op: string, args: Arguments): void {
  for (const field of Object.keys(args))
    if (!API_WRITES[op]!.includes(field))
      throw new ApiRefusal('invalid_request', `${field} isn't a field here.`, { field });
  if (op === 'upcoming.batch') {
    if (Object.hasOwn(args, 'dry_run') && typeof args.dry_run !== 'boolean')
      throw new ApiRefusal('invalid_request', 'dry_run is true or false.', { field: 'dry_run' });
    return;
  }
  if (op === 'upcoming.delete') {
    if (typeof args.id !== 'string' || !args.id || codePointLength(args.id) > 80)
      throw new ApiRefusal('invalid_request', 'id is a string.', { field: 'id' });
    if (!Number.isSafeInteger(args.revision) || Number(args.revision) < 1)
      throw new ApiRefusal('invalid_request', 'Send the revision you read, a whole number.', { field: 'revision' });
    return;
  }
  for (const field of ['date', 'id', 'revision', 'written_at'])
    if (Object.hasOwn(args, field) && (typeof args[field] !== 'string' || codePointLength(String(args[field])) > 80))
      throw new ApiRefusal('invalid_request', `${field} is a string.`, { field });
}

/** A refused date in `/v1`'s words, naming the entry (`change[2]`). */
function upcomingRefusal(error: ApiError): ApiRefusal {
  const list = error.extra.list,
    at = typeof list === 'string' && typeof error.extra.index === 'number' ? `${list}[${error.extra.index}]` : null,
    field = at ?? (error.error === 'upcoming-batch' ? 'add' : null),
    where = at ? ` (${at})` : '',
    extra = field ? { field } : {};
  if (error.error === 'places-failed')
    return new ApiRefusal(
      'unavailable',
      'The city search is unavailable. Try again shortly with the same Idempotency-Key.'
    );
  if (error.error === 'upcoming-missing')
    return new ApiRefusal(
      'not_found',
      `There is no saved date with that id${where}. GET /v1/upcoming lists the current ones.`,
      extra
    );
  if (error.error === 'upcoming-changed')
    return new ApiRefusal(
      'revision_mismatch',
      `That date changed since you read it${where}. Read GET /v1/upcoming again and redo the change.`,
      extra
    );
  return new ApiRefusal('invalid_request', (UPCOMING_HINTS[error.error] ?? "That date isn't right.") + where, extra);
}

export async function writeApi(
  context: CaptureContext,
  event: Arguments,
  options: { fetchTitle?: TitleFetcher; log?: SafeLog } = {}
): Promise<ApiAnswer> {
  const store = context.store,
    now = context.now,
    op = String(event.api),
    args = object(event.arguments) ? event.arguments : {};
  if (!Object.hasOwn(API_WRITES, op)) throw new ApiRefusal('not_found', 'There is no such request.');
  const check = await checkToken(store, context.origin, now, 'Bearer ' + String(event.token ?? ''));
  if (!check.ok) throw new ApiRefusal(check.code, '');
  const token = check.token,
    profile = check.profile,
    uid = String(token.user_id),
    tid = String(token.id),
    name = String(token.name),
    client = typeof event.client === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(event.client) ? event.client : null,
    tz = String(profile.tz),
    today = localDay(now, tz),
    birthday = String(profile.birthday),
    record = (events: Parameters<typeof recordActivity>[3]) =>
      recordActivity(store, uid, now, events, activityLog(now, options.log));

  if (op === 'token.revoke') {
    if (!(await store.revokeToken(token))) throw new ApiRefusal('busy', 'Try again shortly.');
    await record([
      {
        kind: 'connection.removed',
        id: tid,
        fields: { via: 'token', connection: tid, client: name, token: name, reason: 'client' }
      }
    ]);
    return { status: 204, body: null, replayed: false };
  }

  if (!scopesOf(token).includes(scopeFor(op))) throw new ApiRefusal('scope_required', SCOPE_REFUSALS[scopeFor(op)]!);
  shape(op, args);
  const key = typeof event.key === 'string' && event.key ? event.key : randomUUID(),
    receiptKey = 'CAPTURE#' + tid + '#' + digest(key),
    hash = fingerprint({ api: op, arguments: args }),
    limitName = op === 'notes.create' ? 'create' : op.startsWith('upcoming.') ? 'upcoming' : 'change',
    cap = V1_LIMITS[limitName],
    rateKey = `WRITERATE#v1-${limitName}#${Math.floor(now / 86400)}`,
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
  const day = (value: unknown): string => {
    if (typeof value !== 'string' || !validDay(value))
      throw new ApiRefusal('invalid_request', 'A date is YYYY-MM-DD.', { field: 'date' });
    if (value < birthday || value > today)
      throw new ApiRefusal('date_out_of_range', 'Choose a day from your birthday through today.', { field: 'date' });
    return value;
  };
  const own = async (): Promise<OAuthRow> => {
    const d = day(args.date),
      old = await store.note(uid, d, String(args.id), true);
    if (!old) throw new ApiRefusal('not_found', 'There is no note with that date and id.');
    if (old.source !== 'api' || old.connection !== tid)
      throw new ApiRefusal('not_yours', 'A token changes only the notes it wrote.');
    return old;
  };
  // Upcoming: the dates a save would change, checked as a whole against
  // what is saved now, and what it answers.
  const upcomingChanges = async (): Promise<UpcomingChange[]> => {
    let batch: UpcomingBatch;
    try {
      if (op === 'upcoming.delete') batch = { add: [], change: [], remove: [{ id: args.id, revision: args.revision }] };
      else {
        const lists = { ...args };
        delete lists.dry_run;
        batch = batchShape(lists);
      }
      const size = batch.add.length + batch.change.length + batch.remove.length;
      if (!size) throw new ApiRefusal('invalid_request', 'Send at least one date to add, change or remove.');
      if (size > V1_UPCOMING_MAX)
        throw new ApiRefusal('invalid_request', `Send at most ${V1_UPCOMING_MAX} dates a request.`, { field: 'add' });
      return (
        await prepareUpcomingBatch(
          batch,
          await context.store.upcomingEntries(uid),
          today,
          iso(now),
          context.geocode ?? search
        )
      ).changes;
    } catch (error) {
      if (error instanceof ApiError) throw upcomingRefusal(error);
      throw error;
    }
  };
  const upcomingBody = (changes: readonly UpcomingChange[], dry: boolean): OAuthRow => {
    const view = (c: UpcomingChange) =>
      agentUpcomingView({ ...(c.next as UpcomingEntry), occurrence: occurrence(c.next!, today) });
    return {
      dry_run: dry,
      added: changes.filter((c) => !c.previous).map(view),
      changed: changes.filter((c) => c.previous && c.next).map(view),
      removed: changes.filter((c) => !c.next).map((c) => c.previous!.id)
    };
  };
  // A dry run checks the dates, cities found, and writes nothing: no
  // receipt, no count.
  if (op === 'upcoming.batch' && args.dry_run === true)
    return { status: 200, body: upcomingBody(await upcomingChanges(), true), replayed: false };

  for (let attempt = 0; attempt < 5; attempt++) {
    const receipt = await store.mcpGet('USER#' + uid, receiptKey);
    if (live(receipt, now)) {
      if (receipt.request_hash !== hash)
        throw new ApiRefusal(
          'idempotency_mismatch',
          'That Idempotency-Key went with a different request. Use a new key for a new request.'
        );
      const saved = JSON.parse(String(receipt.result)) as { status: number; body: OAuthRow | null };
      return { status: saved.status, body: saved.body, replayed: true };
    }
    const previous = await store.mcpGet('MCPMETA#' + uid, rateKey),
      count = Number(previous?.n ?? 0);
    const reset = untilUtcMidnight(now);
    if (count >= cap)
      throw new ApiRefusal(
        'rate_limited',
        limitName === 'create'
          ? `That's today's ${cap} notes through tokens. Try again after midnight UTC.`
          : limitName === 'upcoming'
            ? `That's today's ${cap} Upcoming saves through tokens. Try again after midnight UTC.`
            : `That's today's ${cap} changes through tokens. Try again after midnight UTC.`,
        { retry_after: reset }
      );
    const rate = {
        pk: 'MCPMETA#' + uid,
        sk: rateKey,
        n: count + 1,
        revision: Number(previous?.revision ?? 0) + 1,
        expires_at: (Math.floor(now / 86400) + 2) * 86400
      },
      limit = { limit: cap, remaining: cap - count - 1, reset },
      audit = (fields: OAuthRow) => ({
        pk: 'MCPMETA#' + uid,
        sk: `LOG#${String(now).padStart(12, '0')}#${randomUUID().replace(/-/g, '')}`,
        at: now,
        tool: 'v1:' + op,
        outcome: 'ok',
        connection: tid,
        client: name,
        ...fields,
        expires_at: now + 14 * 86400
      }),
      receiptFor = (status: number, body: OAuthRow | null) => ({
        pk: 'USER#' + uid,
        sk: receiptKey,
        request_hash: hash,
        result: JSON.stringify({ status, body }),
        expires_at: now + V1_RECEIPT_SECONDS
      });

    let landed: boolean, answer: ApiAnswer, after: () => Promise<void>;
    if (op === 'tags.pinned') {
      const pins = pinnedTags(args.pinned);
      if (!pins) throw new ApiRefusal('invalid_request', 'pinned is a list of up to 12 tags.', { field: 'pinned' });
      const old = Array.isArray(profile.pinned_tags) ? pinsOf(profile) : null,
        row = await tagRow(store, uid, { ...profile, pinned_tags: pins }, today),
        body = { ...row };
      landed = await store.setPins(uid, pins, old, [
        ...store.tokenProof(token, now, 'notes:write'),
        ...store.agentReceipts(receiptFor(200, body), audit({}), rate, previous, now)
      ]);
      answer = { status: 200, body, replayed: false, limit };
      after = async () => {
        if (JSON.stringify(old ?? []) !== JSON.stringify(pins))
          await record([
            {
              kind: 'settings.changed',
              id: again('pinned_tags'),
              fields: {
                via: 'token',
                token: name,
                ...(client ? { client } : {}),
                changes: [{ field: 'pinned_tags', from: old ?? [], to: pins }]
              }
            }
          ]);
      };
    } else if (op === 'upcoming.batch' || op === 'upcoming.delete') {
      const changes = await upcomingChanges(),
        status = op === 'upcoming.delete' ? 204 : 200,
        body = status === 204 ? null : upcomingBody(changes, false),
        named = (events: readonly ActivityEvent[]) =>
          events.map((e) => ({ ...e, fields: { ...e.fields, token: name } }));
      landed = (
        await context.store.upcomingBatch(uid, changes, [
          ...store.tokenProof(token, now, 'upcoming'),
          ...store.agentReceipts(receiptFor(status, body), audit({ count: changes.length }), rate, previous, now)
        ])
      ).ok;
      answer = { status, body, replayed: false, limit };
      after = async () => {
        // Dates added count toward the Roadmap, as from anywhere else.
        const won = await earnedBy(context.store, uid, profile, now, addedEvents(changes, now, tz), {
          via: 'token',
          ...(client ? { client } : {}),
          log: (f) => (options.log ?? safeLog)(f)
        });
        if (body && profile.badges !== false)
          answer.body = { ...body, unlocked: won.unlocked.map((u) => ({ key: u.key, name: u.name })) };
        await record([...named(upcomingEvents(changes, 'token', client ?? undefined)), ...named(won.events)]);
      };
    } else if (op === 'notes.delete') {
      const old = await own(),
        d = String(args.date),
        id = String(args.id),
        files = mediaKeys(old as NoteRecord);
      landed = await store.apiNoteDelete(
        old,
        receiptFor(204, null),
        audit({ date: d, note_id: id }),
        rate,
        previous,
        token,
        now
      );
      answer = { status: 204, body: null, replayed: false, limit };
      after = async () => {
        // The capture role may remove only what was uploaded; a token's notes
        // have nothing else.
        const ours = files.filter((k) => k.startsWith(`media/${uid}/files/`));
        if (ours.length && context.objects) await Promise.allSettled(ours.map((k) => context.objects!.remove(k)));
        await record([
          {
            kind: 'note.deleted',
            id: again(id),
            fields: {
              via: 'token',
              token: name,
              ...(client ? { client } : {}),
              day: d,
              note: id,
              files: ((old.media as OAuthRow[] | undefined) ?? []).length
            }
          }
        ]);
      };
    } else {
      let words = text(args),
        old: OAuthRow | null = null,
        typed = now,
        d: string;
      if (op === 'notes.create') {
        if (Object.hasOwn(args, 'written_at')) {
          const at = String(args.written_at),
            seconds = Date.parse(at) / 1000;
          if (!RFC3339.test(at) || !Number.isFinite(seconds))
            throw new ApiRefusal('invalid_request', 'written_at is an RFC 3339 time.', { field: 'written_at' });
          if (seconds > now + 300)
            throw new ApiRefusal('invalid_request', 'written_at is in the future.', { field: 'written_at' });
          // A minute or two ahead of this clock is still now.
          typed = Math.min(Math.floor(seconds), now);
        }
        // Words typed offline file to the day they were typed, unless a date
        // says otherwise.
        d = day(Object.hasOwn(args, 'date') ? args.date : localDay(typed, tz));
      } else {
        old = await own();
        d = String(args.date);
        if (op === 'notes.edit' && editRevision(old) !== args.revision)
          throw new ApiRefusal(
            'revision_mismatch',
            'This note changed since it was read. Read it again and redo the edit from its current text.',
            { revision: editRevision(old) }
          );
        if (op === 'notes.append') words = String(old.text ?? '') + '\n\n' + words;
      }
      tooLong(words);
      const note: OAuthRow = old
        ? { pk: old.pk, sk: old.sk }
        : {
            pk: 'USER#' + uid,
            sk: `NOTE#${d}#t-${randomUUID().replace(/-/g, '')}`,
            source: 'api',
            connection: tid,
            token: name,
            ...(client ? { client } : {}),
            written_at: iso(typed),
            tz,
            version: computeVersion(birthday, d).toString()
          };
      Object.assign(note, {
        text: words,
        tags: found(words),
        links: await collect(words, { keep: old?.links as Link[] | undefined, fetch: titleOnce }),
        revision: Number(old?.revision ?? 0) + 1
      });
      if (old) note.updated_at = iso(now);
      const id = String(note.sk).split('#').slice(2).join('#'),
        full = { ...old, ...note },
        body: OAuthRow = {
          note: {
            id,
            date: d,
            version: String(full.version ?? computeVersion(birthday, d).toString()),
            revision: editRevision(full),
            token: String(full.token ?? name)
          }
        };
      const status = old ? 200 : 201;
      landed = await store.apiNoteCommit(
        note,
        old,
        receiptFor(status, body),
        audit({ date: d, note_id: id }),
        rate,
        previous,
        token,
        now
      );
      answer = { status, body, replayed: false, limit };
      after = async () => {
        let unlocked: Unlocked[] = [];
        if (profile.badges !== false)
          try {
            unlocked = await unlockedBy(context.store, uid, profile, today, full, old, [], (f) =>
              (options.log ?? safeLog)(f)
            );
          } catch {
            (options.log ?? safeLog)({ event: 'badges-error', user: uid, date: d });
          }
        if (profile.badges !== false)
          answer.body = { ...body, unlocked: unlocked.map((u) => ({ key: u.key, name: u.name })) };
        await record([
          {
            kind: old ? 'note.edited' : 'note.added',
            id: old ? again(id) : id,
            fields: {
              via: 'token',
              token: name,
              ...(client ? { client } : {}),
              day: d,
              note: id,
              version: full.version
            }
          },
          ...badgeEvents(unlocked, 'token', d, id, client).map((e) => ({
            ...e,
            fields: { ...e.fields, token: name }
          }))
        ]);
      };
    }
    if (landed) {
      await after();
      return answer;
    }
    // A lost race on the receipt or the count goes round again; a token or
    // account that changed is told as such.
    const now2 = await checkToken(store, context.origin, now, 'Bearer ' + String(event.token ?? ''));
    if (!now2.ok) throw new ApiRefusal(now2.code, '');
    if (now2.token.revision !== token.revision) throw new ApiRefusal('token_revoked', '');
    if (op.startsWith('notes.') && op !== 'notes.create') {
      // The note itself may have moved on (a web edit meanwhile).
      const current = await store.note(uid, String(args.date), String(args.id), true);
      if (!current) throw new ApiRefusal('not_found', 'There is no note with that date and id.');
      if (op === 'notes.edit' && editRevision(current) !== args.revision)
        throw new ApiRefusal(
          'revision_mismatch',
          'This note changed since it was read. Read it again and redo the edit from its current text.',
          { revision: editRevision(current) }
        );
    }
    // Pins changed on the web meanwhile: read them again.
    if (op === 'tags.pinned') {
      const fresh = await store.mcpProfile(uid);
      if (fresh) Object.assign(profile, { pinned_tags: fresh.pinned_tags });
      if (fresh && !Object.hasOwn(fresh, 'pinned_tags')) delete profile.pinned_tags;
    }
  }
  throw new ApiRefusal('busy', 'Try again shortly with the same Idempotency-Key.');
}
