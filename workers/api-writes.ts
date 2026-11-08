/** `/v1` writes (docs/API.md), made here in the private capture function as
 * an agent's are: the MCP function's /v1 router checks the token and hands
 * on the request, and this checks it again and proves the live account and
 * token in the same transaction as the write, its 7-day receipt, its
 * content-free audit row and the account's daily count. A token writes in
 * the owner's voice (`source` api, no `author`), and changes only notes it
 * wrote itself. With `upcoming`, it lists nothing here but saves and removes
 * Upcoming dates as an agent does (workers/capture.ts, writeUpcoming): all
 * or nothing, from the revision it read, with a dry run that writes
 * nothing. With `media:write`, it signs forms for files under the owner's
 * media/<user>/api/ (uploads.ts), counted with the web's, and a note takes
 * them as a web note does: checked against the bytes that arrived, copied
 * to a kept key, and the pending file removed only once the note has its
 * copy. Here names a device's spot as the web's Here does. */
import { randomUUID } from 'node:crypto';
import { GeoPlacesClient } from '@aws-sdk/client-geo-places';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import {
  collect,
  fetchTitle,
  MAX_FETCHES,
  type Link,
  type PageMeta,
  type TitleFetcher
} from '../packages/backend/links.ts';
import { live, type OAuthRow } from '../packages/backend/oauth.ts';
import { isRich, RICH } from '../packages/domain/rich.ts';
import { activityLog, again, badgeEvents, recordActivity, upcomingEvents } from '../packages/backend/activity.ts';
import { addedEvents, earnedBy, unlockedBy } from '../packages/backend/badges.ts';
import { keys as mediaKeys, MAX_FILES, nextFile, thumbKeys, withoutFile } from '../packages/backend/media.ts';
import {
  chosen,
  clean,
  fetchJson,
  nameSpot,
  notePlaceOf,
  search,
  spotOf,
  type SpotNames
} from '../packages/backend/places.ts';
import { keepDay, placeOf, type WeatherStore } from '../packages/backend/weather.ts';
import { errorFields, safeLog } from '../packages/backend/services.ts';
import { ApiError } from '../packages/backend/sessions.ts';
import { pinnedTags, storedPins, tagRow, type TagRowStore } from '../packages/backend/tag-row.ts';
import {
  claimUploads,
  dropCopies,
  FORM_SECONDS,
  UPLOAD_BYTES_A_DAY,
  uploadForm,
  uploadRequest,
  UPLOADS_A_DAY,
  type Claimed,
  type UploadRequest
} from '../packages/backend/uploads.ts';
import {
  apiReceiptKey,
  checkToken,
  PER_TOKEN_RECEIPTS_UNTIL,
  perTokenReceiptKey,
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
import { stayOf, staysAt, staysAtNext, staysTagged, stayTagged, withTags, type CheckInReads } from '../packages/backend/check-ins.ts';
import {
  STAY_WRITE_MAX,
  CHECKIN_SOURCES,
  checkInId,
  checkInKey,
  checkInKeyOf,
  checkInName,
  NAMED_PLACE_SPOTS_MAX,
  NAMED_PLACES_MAX,
  namedPlaceKey,
  namedPlaceView,
  sameName,
  stayRevision,
  stayView,
  hiddenStay,
  ignoredAt,
  nearestPlace,
  withIgnored,
  type CheckIn,
  type NamedPlace
} from '../packages/domain/check-ins.ts';
import { iso, localDay, validDay, validTimezone } from '../packages/domain/dates.ts';
import { MAX_NOTE, noteWords, type NoteRecord } from '../packages/domain/notes.ts';
import { TAG_REFUSALS, fieldTags, isRefused, mergeTags, noteTags, storedTags, tagFields, type Tag } from '../packages/domain/tags.ts';
import { occurrence, type UpcomingEntry } from '../packages/domain/upcoming.ts';
import { codePointLength } from '../packages/domain/unicode.ts';
import { computeVersion } from '../packages/domain/version.ts';
import type { ActivityEvent } from '../packages/domain/activity.ts';
import type { Unlocked } from '../packages/domain/badges.ts';
import { agentUpcomingView, editRevision, placeView } from '../server/mcp/reader.ts';
import { fingerprint, object, type Arguments, type SafeLog } from '../server/mcp/common.ts';
import { FILE_TYPES } from '../server/mcp/files.ts';
import type { CaptureContext } from './capture.ts';

type Ops = NonNullable<TransactWriteCommandInput['TransactItems']>;

export interface ApiStore extends TokenReads, TagRowStore, CheckInReads {
  checkInsAt(user: string, second: string): Promise<CheckIn[]>;
  checkInWrites(
    user: string,
    changes: readonly { next?: OAuthRow; old?: OAuthRow }[],
    proofs: Ops,
    last: Ops
  ): Promise<boolean>;
  note(uid: string, day: string, id: string, consistent?: boolean): Promise<OAuthRow | null>;
  tokenProof(token: OAuthRow, now: number, scope: string | readonly string[]): Ops;
  agentReceipts(receipt: OAuthRow, audit: OAuthRow, rate: OAuthRow, previous: OAuthRow | null, now: number): Ops;
  receiptAbsent(user: string, sk: string, now: number): Ops;
  apiNoteCommit(
    note: OAuthRow,
    old: OAuthRow | null,
    receipt: OAuthRow,
    audit: OAuthRow,
    rate: OAuthRow,
    previous: OAuthRow | null,
    token: OAuthRow,
    now: number,
    added?: readonly OAuthRow[],
    extra?: Ops
  ): Promise<boolean>;
  apiUploadCount(
    token: OAuthRow,
    now: number,
    size: number,
    maxFiles: number,
    maxBytes: number
  ): Promise<'ok' | 'limited' | 'retry'>;
  apiNoteDelete(
    old: OAuthRow,
    receipt: OAuthRow,
    audit: OAuthRow,
    rate: OAuthRow,
    previous: OAuthRow | null,
    token: OAuthRow,
    now: number,
    extra?: Ops
  ): Promise<boolean>;
  apiNotePlace(
    old: OAuthRow,
    place: OAuthRow | null,
    receipt: OAuthRow,
    audit: OAuthRow,
    rate: OAuthRow,
    previous: OAuthRow | null,
    token: OAuthRow,
    now: number,
    extra?: Ops
  ): Promise<boolean>;
  apiDayPlace(user: string, day: string, place: OAuthRow | null, extra?: Ops): Promise<boolean>;
  apiMediaRemove(
    old: OAuthRow,
    n: number,
    at: string,
    receipt: OAuthRow,
    audit: OAuthRow,
    rate: OAuthRow,
    previous: OAuthRow | null,
    token: OAuthRow,
    now: number,
    extra?: Ops
  ): Promise<boolean>;
  forLiveAccount(user: string): WeatherStore;
  setPins(user: string, pins: readonly string[], old: readonly string[] | null, extra?: Ops): Promise<boolean>;
  revokeToken(token: OAuthRow): Promise<boolean>;
}

/** The operations the router hands on, each with its body's fields. */
export const API_WRITES: Record<string, readonly string[]> = {
  'notes.create': ['text', 'date', 'written_at', 'place', 'uploads', 'markup', 'tags'],
  'notes.edit': ['date', 'id', 'text', 'revision', 'tags'],
  'notes.append': ['date', 'id', 'text'],
  'notes.media': ['date', 'id', 'uploads'],
  'notes.media.remove': ['date', 'id', 'n'],
  'notes.delete': ['date', 'id'],
  'notes.place': ['date', 'id', 'place'],
  'notes.place.clear': ['date', 'id'],
  'days.place': ['date', 'place'],
  'days.place.clear': ['date'],
  'uploads.start': ['name', 'type', 'size'],
  'places.here': ['lat', 'lon', 'accuracy_m'],
  'tags.pinned': ['pinned'],
  'upcoming.batch': ['add', 'change', 'remove', 'dry_run'],
  'upcoming.delete': ['id', 'revision'],
  'check-ins.add': ['arrived', 'left', 'lat', 'lon', 'accuracy_m', 'time_zone', 'source'],
  'check-ins.name': ['id', 'name', 'revision', 'tags'],
  'check-ins.delete': ['id'],
  'check-ins.delete-all': ['confirm'],
  'check-ins.places.add': ['name', 'lat', 'lon', 'ignored', 'tags'],
  'check-ins.places.change': ['id', 'name', 'ignored', 'tags'],
  'check-ins.places.delete': ['id'],
  'check-ins.places.delete-check-ins': ['id', 'count'],
  'check-ins.places.tag-check-ins': ['id', 'tags', 'count'],
  'token.revoke': []
};

const scopeFor = (op: string) =>
  op.startsWith('upcoming.')
    ? 'upcoming'
    : op === 'uploads.start' || op.startsWith('notes.media')
      ? 'media:write'
      : op.startsWith('days.place') || op.startsWith('check-ins.places.') || op === 'check-ins.delete-all'
        ? 'notes:all'
        : 'notes:write';

/** Here's naming client, made on first use, as the web's is. */
let geo: GeoPlacesClient | undefined;

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

/** An RFC 3339 time whose every field is real: `Date.parse` rolls
 * February 30 over to March 2, and 24:00 to the next day. */
function realTime(at: string): boolean {
  if (!RFC3339.test(at)) return false;
  const [, h, m, s = '00'] = /T(\d{2}):(\d{2})(?::(\d{2}))?/i.exec(at)!,
    offset = /([+-])(\d{2}):(\d{2})$/.exec(at);
  return (
    validDay(at.slice(0, 10)) &&
    Number(h) < 24 &&
    Number(m) < 60 &&
    Number(s) < 60 &&
    (!offset || (Number(offset[2]) < 24 && Number(offset[3]) < 60))
  );
}

/** Seconds until the UTC day ends, when every daily count starts again. */
export const untilUtcMidnight = (now: number): number => (Math.floor(now / 86400) + 1) * 86400 - now;

/** The note's words; a note with files may have none. */
/** A tags field (1.21.0; docs/TAGS.md): null when none was sent, else its
 * tags, each once, or invalid_request saying which and why. */
export function tagsArg(args: Arguments, field = 'tags'): Tag[] | null {
  if (!Object.hasOwn(args, field) || args[field] === undefined || args[field] === null) return null;
  const tags = fieldTags(args[field]);
  if (isRefused(tags))
    throw new ApiRefusal('invalid_request', TAG_REFUSALS[tags.refused] + (tags.at >= 0 ? ` (${field}[${tags.at}])` : ''), {
      field
    });
  return tags;
}

function text(args: Arguments, optional = false): string {
  if (optional && !Object.hasOwn(args, 'text')) return '';
  if (typeof args.text !== 'string') throw new ApiRefusal('text_required', 'Send the note as text.', { field: 'text' });
  const value = noteWords(args.text);
  if (!value && !optional) throw new ApiRefusal('text_required', 'Write some text for the note.', { field: 'text' });
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
  if (op === 'uploads.start') {
    for (const field of ['name', 'type'])
      if (Object.hasOwn(args, field) && (typeof args[field] !== 'string' || codePointLength(String(args[field])) > 255))
        throw new ApiRefusal('invalid_request', `${field} is a string.`, { field });
    return;
  }
  // The spot is checked whole, as the web's Here checks it.
  if (op === 'places.here') return;
  // Each of these checks its own fields where it's made (checkInReport).
  if (op.startsWith('check-ins.')) return;
  if (op === 'upcoming.delete') {
    if (typeof args.id !== 'string' || !args.id || codePointLength(args.id) > 80)
      throw new ApiRefusal('invalid_request', 'id is a string.', { field: 'id' });
    if (!Number.isSafeInteger(args.revision) || Number(args.revision) < 1)
      throw new ApiRefusal('invalid_request', 'Send the revision you read, a whole number.', { field: 'revision' });
    return;
  }
  // Plain words are the default, and null is how a read says so.
  if (Object.hasOwn(args, 'markup') && args.markup !== RICH && args.markup !== null)
    throw new ApiRefusal('invalid_request', 'markup is rich, or left out for plain words.', { field: 'markup' });
  for (const field of ['date', 'id', 'revision', 'written_at'])
    if (Object.hasOwn(args, field) && (typeof args[field] !== 'string' || codePointLength(String(args[field])) > 80))
      throw new ApiRefusal('invalid_request', `${field} is a string.`, { field });
  // An edit with no revision is a request missing a field, not a note that
  // changed since it was read.
  if (op === 'notes.edit' && !args.revision)
    throw new ApiRefusal('invalid_request', 'Send the revision you read, as it came.', { field: 'revision' });
}

/** A refused date in `/v1`'s words, naming the entry (`change[2]`); for
 * `DELETE /v1/upcoming/{id}` (`one`), which sends no list, the date is the
 * one in the address and a stale revision is the `revision` sent with it. */
function upcomingRefusal(error: ApiError, one = false): ApiRefusal {
  const list = one ? null : error.extra.list,
    at = typeof list === 'string' && typeof error.extra.index === 'number' ? `${list}[${error.extra.index}]` : null,
    field =
      at ?? (error.error === 'upcoming-batch' ? 'add' : one && error.error === 'upcoming-changed' ? 'revision' : null),
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

/** A note's place, from the search or Here. */
function placeFrom(raw: unknown): OAuthRow {
  const place = notePlaceOf(raw);
  if (!place)
    throw new ApiRefusal(
      'invalid_request',
      'place is a city from GET /v1/places, or the place POST /v1/places/here answered, sent back as it came.',
      { field: 'place' }
    );
  return place;
}

/** A refused file in `/v1`'s words (uploads.ts says which). */
function uploadRefusal(error: ApiError): ApiRefusal {
  if (error.error === 'file-type') return new ApiRefusal('invalid_request', FILE_TYPES, { field: 'type' });
  if (error.error === 'file-size')
    return new ApiRefusal('invalid_request', "size is the file's exact size in bytes.", { field: 'size' });
  if (error.error === 'file-too-big')
    return new ApiRefusal('too_large', 'A file can be at most 50 MB.', { field: 'size' });
  return new ApiRefusal(
    'invalid_request',
    "An upload isn't there or doesn't match what arrived. Each is {upload, type} as POST /v1/uploads answered, " +
      'sent after the file was posted to its form; a note takes each once.',
    { field: 'uploads' }
  );
}

/** How far ahead a phone's clock can be, for a stay's times. */
const AHEAD_SECONDS = 7 * 86400;

/** What a phone reported, checked: its times as the log keeps them. */
interface CheckInReport {
  arrived: string | null;
  left: string | null;
  at: string;
  day: string;
  source: string;
  time_zone: string;
  lat: number;
  lon: number;
  accuracy_m?: number;
}
function checkInReport(args: Arguments, now: number, birthday: string, tz: string): CheckInReport {
  const spot = spotOf(args);
  if (!spot)
    throw new ApiRefusal('invalid_request', 'Send lat and lon in degrees, and accuracy_m in metres if you have it.', {
      field: 'lat'
    });
  const source = args.source;
  if (typeof source !== 'string' || !(CHECKIN_SOURCES as readonly string[]).includes(source))
    throw new ApiRefusal('invalid_request', `source is ${CHECKIN_SOURCES.join(' or ')}.`, { field: 'source' });
  const when = (field: 'arrived' | 'left'): string | null => {
    const raw = args[field] ?? null;
    if (raw === null) return null;
    if (typeof raw !== 'string' || !realTime(raw) || !Number.isFinite(Date.parse(raw)))
      throw new ApiRefusal('invalid_request', `${field} is an RFC 3339 time, or null.`, { field });
    if (Date.parse(raw) / 1000 > now + AHEAD_SECONDS)
      throw new ApiRefusal('invalid_request', `${field} is more than a week ahead.`, { field });
    // A day and a half before the birthday began in UTC is before it in every
    // zone, and a time near year 1 is past what a zone's calendar can name.
    if (Date.parse(raw) / 1000 < Date.parse(`${birthday}T00:00:00Z`) / 1000 - 1.5 * 86400)
      throw new ApiRefusal('date_out_of_range', 'Choose a time from your birthday on.', { field });
    return new Date(Date.parse(raw)).toISOString();
  };
  const arrived = when('arrived'),
    left = when('left');
  if (source === 'tap' && left !== null)
    throw new ApiRefusal('invalid_request', 'A tap is a moment: send arrived, and no left.', { field: 'left' });
  if (source === 'visit' && arrived === null && left === null)
    throw new ApiRefusal('invalid_request', 'A visit says when it began or ended.', { field: 'arrived' });
  if (arrived !== null && left !== null && left < arrived)
    throw new ApiRefusal('invalid_request', 'A stay can’t end before it began.', { field: 'left' });
  const zone = args.time_zone ?? null;
  if (zone !== null && !validTimezone(zone))
    throw new ApiRefusal('invalid_request', 'time_zone is an IANA name, like America/Chicago.', {
      field: 'time_zone'
    });
  const at = arrived ?? left ?? new Date(now * 1000).toISOString(),
    day = localDay(Date.parse(at) / 1000, tz);
  if (day < birthday)
    throw new ApiRefusal('date_out_of_range', 'Choose a time from your birthday on.', {
      field: arrived ? 'arrived' : 'left'
    });
  return { arrived, left, at, day, source, time_zone: zone ?? tz, ...spot };
}
/** `ignored` as sent for a place: true or false, or undefined when left out. */
function ignoredFrom(args: Arguments): boolean | undefined {
  if (!Object.hasOwn(args, 'ignored')) return undefined;
  if (typeof args.ignored !== 'boolean')
    throw new ApiRefusal('invalid_request', 'ignored is true or false.', { field: 'ignored' });
  return args.ignored;
}
/** A name sent for a stop or a place. */
function nameFrom(raw: unknown): string {
  const name = checkInName(raw);
  if (!name) throw new ApiRefusal('invalid_request', 'name is up to 100 characters on one line.', { field: 'name' });
  return name;
}
const NO_CHECK_IN = 'There is no check-in with that id. GET /v1/check-ins lists them.',
  NO_PLACE = 'There is no remembered place with that id. GET /v1/check-ins/places lists them.';

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
    // Every row a token writes names it by id as well as by name (API 1.4.0),
    // so a client tells its own rows from another token's of the same name.
    record = (events: Parameters<typeof recordActivity>[3]) =>
      recordActivity(
        store,
        uid,
        now,
        events.map((e) => ({ ...e, fields: { ...e.fields, token_id: tid } })),
        activityLog(now, options.log)
      );

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
  const withFiles = op === 'notes.media' || (op === 'notes.create' && Object.hasOwn(args, 'uploads'));
  if (withFiles && !scopesOf(token).includes('media:write'))
    throw new ApiRefusal('scope_required', SCOPE_REFUSALS['media:write']!);
  shape(op, args);
  // A token checked again after its write was refused: still live and the
  // same revision, or refused as it now is.
  const stillLive = async () => {
    const fresh = await checkToken(store, context.origin, now, 'Bearer ' + String(event.token ?? ''));
    if (!fresh.ok) throw new ApiRefusal(fresh.code, '');
    if (fresh.token.revision !== token.revision) throw new ApiRefusal('token_revoked', '');
  };

  // A signed form for one file, counted with the web's uploads. No receipt:
  // a retry gets a new form, as on the web, and an unused one expires.
  if (op === 'uploads.start') {
    let request: UploadRequest;
    try {
      request = uploadRequest(args);
    } catch (error) {
      if (error instanceof ApiError) throw uploadRefusal(error);
      throw error;
    }
    if (!context.objects) throw new Error('Files service missing');
    for (let attempt = 0; attempt < 5; attempt++) {
      const counted = await store.apiUploadCount(token, now, request.size, UPLOADS_A_DAY, UPLOAD_BYTES_A_DAY);
      if (counted === 'limited')
        throw new ApiRefusal(
          'rate_limited',
          `That's today's ${UPLOADS_A_DAY} files or 2 GB of uploads for this account. Try again after midnight UTC.`,
          { retry_after: untilUtcMidnight(now) }
        );
      if (counted === 'ok')
        return {
          status: 201,
          body: { ...(await uploadForm(context.objects, uid, request, 'api')), expires_in: FORM_SECONDS },
          replayed: false
        };
      await stillLive();
    }
    throw new ApiRefusal('busy', 'Try again shortly.');
  }

  // Here: a device's spot named for a note, as the web's Here names it, with
  // the businesses near enough to offer. Counted, since each is a paid
  // lookup; it writes nothing else, so it has no receipt.
  if (op === 'places.here') {
    const spot = spotOf(args);
    if (!spot)
      throw new ApiRefusal('invalid_request', 'Send lat and lon in degrees, and accuracy_m in metres if you have it.', {
        field: 'lat'
      });
    const hereKey = `WRITERATE#v1-here#${Math.floor(now / 86400)}`,
      cap = V1_LIMITS.here;
    let remaining = -1;
    for (let attempt = 0; attempt < 5 && remaining < 0; attempt++) {
      const previous = await store.mcpGet('MCPMETA#' + uid, hereKey),
        count = Number(previous?.n ?? 0);
      if (count >= cap)
        throw new ApiRefusal(
          'rate_limited',
          `That's today's ${cap} spots named through tokens. Try again after midnight UTC.`,
          { retry_after: untilUtcMidnight(now) }
        );
      const row = {
        pk: 'MCPMETA#' + uid,
        sk: hereKey,
        n: count + 1,
        expires_at: (Math.floor(now / 86400) + 2) * 86400
      };
      if (await store.mcpCommit([[row, previous ? Number(previous.revision) : null]], uid)) remaining = cap - count - 1;
      else await stillLive();
    }
    if (remaining < 0) throw new ApiRefusal('busy', 'Try again shortly.');
    let named: SpotNames | null;
    try {
      named = await (context.nameSpot ?? ((s) => nameSpot(s, (geo ??= new GeoPlacesClient({})))))(spot);
    } catch (error) {
      (options.log ?? safeLog)({ event: 'here-error', user: uid, ...errorFields(error) });
      throw new ApiRefusal('unavailable', 'Naming the spot is unavailable. Try again shortly.');
    }
    if (!named?.city)
      throw new ApiRefusal('not_found', "Couldn't find a city for that spot. Search for one with GET /v1/places?q=.");
    return {
      status: 200,
      body: {
        place: {
          name: named.city,
          region: named.region ?? '',
          country: named.country ?? '',
          ...(named.tz ? { tz: named.tz } : {}),
          ...(named.district ? { district: named.district } : {}),
          ...spot,
          from: 'device'
        },
        nearby: named.nearby
      },
      replayed: false,
      limit: { limit: cap, remaining, reset: untilUtcMidnight(now) }
    };
  }
  // A receipt is the account's (API 1.4.0): a key sent again through any of
  // its tokens gets the first answer. Until PER_TOKEN_RECEIPTS_UNTIL, a
  // receipt written before then under this token's own key answers too, and
  // a write commits only while none is live there.
  const key = typeof event.key === 'string' && event.key ? event.key : randomUUID(),
    receiptKey = apiReceiptKey(key),
    legacyKey = now < PER_TOKEN_RECEIPTS_UNTIL ? perTokenReceiptKey(tid, key) : null,
    legacyGuard = (): Ops => (legacyKey ? store.receiptAbsent(uid, legacyKey, now) : []),
    hash = fingerprint({ api: op, arguments: args }),
    limitName =
      op === 'notes.create'
        ? 'create'
        : op.startsWith('upcoming.')
          ? 'upcoming'
          : op === 'check-ins.add'
            ? 'checkin'
            : 'change',
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
  // A note this token may change: one it wrote, or any note it reaches with
  // notes:all (1.10.0 its words; 1.11.0, Jamie, 2026-10-30, deleting it and
  // adding files too).
  const own = async (): Promise<OAuthRow> => {
    const d = day(args.date),
      old = await store.note(uid, d, String(args.id), true);
    if (!old) throw new ApiRefusal('not_found', 'There is no note with that date and id.');
    if ((old.source !== 'api' || old.connection !== tid) && !scopesOf(token).includes('notes:all'))
      throw new ApiRefusal('not_yours', 'A token changes only the notes it wrote, unless it may reach all your notes.');
    return old;
  };
  // What a write to a note answers.
  const written = (full: OAuthRow, d: string, id: string): OAuthRow => ({
    note: {
      id,
      date: d,
      version: String(full.version ?? computeVersion(birthday, d).toString()),
      revision: editRevision(full),
      files: ((full.media as OAuthRow[] | undefined) ?? []).length,
      token: String(full.token ?? name)
    }
  });
  // The day's weather follows where it was, as on the web. The write has
  // landed by now, so nothing here may fail it.
  const keepWeather = async (d: string, changed: boolean) => {
    try {
      await keepDay(
        store.forLiveAccount(uid),
        uid,
        placeOf(profile),
        tz,
        d,
        today,
        context.weatherFetch ?? fetchJson,
        iso(now),
        changed
      );
    } catch {
      (options.log ?? safeLog)({ event: 'weather-error', user: uid, date: d });
    }
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
      if (error instanceof ApiError) throw upcomingRefusal(error, op === 'upcoming.delete');
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

  const by = () => ({ via: 'token', token: name, token_id: tid, ...(client ? { client } : {}) });
  // Ignoring or unignoring a remembered place, in the log by its id alone.
  const ignoreEvent = (place: string, ignored: boolean): ActivityEvent => ({
    kind: ignored ? 'checkin.ignored' : 'checkin.unignored',
    id: again(place),
    fields: { ...by(), place }
  });
  // The stay a check-in is part of, and whether this token may change it: all
  // of it its own, or any with notes:all.
  const checkInStay = async (places: readonly NamedPlace[]): Promise<CheckIn[]> => {
    const sk = checkInKeyOf(String(args.id)),
      item = sk ? ((await store.mcpGet('USER#' + uid, sk)) as CheckIn | null) : null;
    if (!item) throw new ApiRefusal('not_found', NO_CHECK_IN);
    const members = await stayOf(store, uid, item, places);
    // A stay at an ignored place is hidden, as if it weren't there.
    if (hiddenStay(members, places)) throw new ApiRefusal('not_found', NO_CHECK_IN);
    if (members.some((m) => m.connection !== tid) && !scopesOf(token).includes('notes:all'))
      throw new ApiRefusal(
        'not_yours',
        'A token changes only the check-ins it sent, unless it may reach all your notes.'
      );
    return members;
  };
  // Remembered places are the account's, read with the log. A token that may
  // only add its own stops sees what it sent, and no name it could probe for.
  const namesFor = (places: readonly NamedPlace[]) =>
    scopesOf(token).some((scope) => scope === 'activity' || scope === 'notes:all') ? places : [];
  const stayProof = (members: readonly CheckIn[]) =>
    store.tokenProof(
      token,
      now,
      members.every((m) => m.connection === tid) ? 'notes:write' : ['notes:write', 'notes:all']
    );
  // A stop's neighbourhood and city, asked once however often the write goes
  // round, and never failing it: a stop with no name still happened.
  let looked: { district: string | null } | undefined;
  const lookUp = async (spot: { lat: number; lon: number }) => {
    if (looked) return looked;
    try {
      const named = await (context.nameSpot ?? ((s) => nameSpot(s, (geo ??= new GeoPlacesClient({})))))({
        lat: spot.lat,
        lon: spot.lon
      });
      looked = { district: named ? [named.district, named.city].filter(Boolean).join(', ') || null : null };
    } catch (error) {
      (options.log ?? safeLog)({ event: 'check-in-name-error', user: uid, ...errorFields(error) });
      looked = { district: null };
    }
    return looked;
  };
  let wiped: number | undefined;

  // Files a note takes, checked and copied once, on the first attempt that
  // gets past the receipt and the count. The pending files go once a note
  // has its copies; copies no note took go instead, unless the commit's
  // answer was lost and its receipt says it may have landed (an orphan file
  // beats a note without its file).
  let claimed: Claimed | undefined,
    committed = false,
    unsure = false;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      let receipt = await store.mcpGet('USER#' + uid, receiptKey);
      if (!live(receipt, now) && legacyKey) receipt = await store.mcpGet('USER#' + uid, legacyKey);
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
              : limitName === 'checkin'
                ? `That's today's ${cap} check-ins through tokens. Try again after midnight UTC.`
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
      if (op === 'check-ins.add') {
        const report = checkInReport(args, now, birthday, tz),
          second = (at: string | null) => at?.slice(0, 19) ?? null,
          // A later report of the same stay, to the second, fills it in. A tap
          // is never continued. A token continues its own, or any with
          // notes:all; otherwise its report is its own check-in, which reads
          // as one stay with the other's.
          matches =
            report.source === 'tap'
              ? []
              : (await store.checkInsAt(uid, second(report.at)!)).filter(
                  (c) =>
                    c.source === report.source &&
                    second(c.arrived) === second(report.arrived) &&
                    (report.arrived !== null || second(c.left) === second(report.left))
                ),
          same =
            matches.find((c) => c.connection === tid) ??
            (scopesOf(token).includes('notes:all') ? matches[0] : undefined),
          places = await store.namedPlaces(uid),
          // A new stop at an ignored place is not kept (Jamie, 2026-11-08):
          // only the receipt is written, and the answer says so. A report
          // filling in one kept before the place was ignored still lands.
          kept = Boolean(same) || !ignoredAt(report, places),
          lookups = Number(previous?.lookups ?? 0),
          paid = kept && !same && (looked !== undefined || lookups < V1_LIMITS.lookups),
          district = paid ? (await lookUp(report)).district : null,
          random = randomUUID().replace(/-/g, ''),
          id = same?.id ?? checkInId(report.at, random),
          left = report.left ?? same?.left ?? null,
          // A new stop takes the tags of the remembered place it is at.
          at = same ? null : nearestPlace(report, places),
          item: OAuthRow = same
            ? { ...same, left, revision: Number(same.revision) + 1 }
            : {
                pk: 'USER#' + uid,
                sk: checkInKey(report.at, id),
                id,
                ...report,
                accuracy_m: report.accuracy_m ?? null,
                district,
                name: null,
                ...(at ? tagFields(storedTags(at)) : {}),
                ...by(),
                connection: tid,
                revision: 1
              },
          // Nothing new in a report sent again: only its receipt is written.
          changed = kept && (!same || same.left !== left),
          status = same || !kept ? 200 : 201,
          body = {
            check_in: stayView([(changed || !kept ? item : same) as CheckIn], namesFor(places)),
            kept
          };
        Object.assign(rate, { lookups: lookups + (paid ? 1 : 0) });
        landed = await store.checkInWrites(
          uid,
          changed ? [{ next: item, ...(same ? { old: same } : {}) }] : [],
          stayProof(same ? [same] : []),
          [
            ...store.agentReceipts(receiptFor(status, body), audit({ checkin: id }), rate, previous, now),
            ...legacyGuard()
          ]
        );
        answer = {
          status,
          body,
          replayed: false,
          limit: {
            limit: V1_LIMITS.lookups,
            remaining: Math.max(0, V1_LIMITS.lookups - lookups - (paid ? 1 : 0)),
            reset
          }
        };
        after = async () => undefined;
      } else if (op === 'check-ins.name') {
        // A name (null takes it away), tags (1.21.0), or both.
        const tagging = tagsArg(args),
          naming = Object.hasOwn(args, 'name');
        if (!naming && !tagging)
          throw new ApiRefusal('invalid_request', 'Send name (null takes it away), tags, or both.', { field: 'name' });
        if (!Number.isSafeInteger(args.revision) || Number(args.revision) < 1)
          throw new ApiRefusal('invalid_request', 'Send the revision you read, a whole number.', { field: 'revision' });
        const given = !naming || args.name === null ? null : nameFrom(args.name),
          places = await store.namedPlaces(uid),
          members = await checkInStay(places);
        if (stayRevision(members) !== args.revision)
          throw new ApiRefusal('revision_mismatch', 'That check-in changed since you read it. Read it again.', {
            revision: stayRevision(members)
          });
        // Naming has to land whole, or the stay would split on the way, so it
        // stays inside one transaction.
        if (members.length > STAY_WRITE_MAX)
          throw new ApiRefusal(
            'invalid_request',
            `A stay of more than ${STAY_WRITE_MAX} check-ins can't take one name. Delete some of it first.`,
            { field: 'id' }
          );
        const named = members.map((m) => ({
            ...(tagging ? withTags(m, tagging) : m),
            name: naming ? given : (m.name ?? null),
            revision: Number(m.revision) + 1
          })),
          retagged = tagging !== null && stayTagged(members, tagging).length > 0,
          body = { check_in: stayView(named, namesFor(places)) };
        landed = await store.checkInWrites(
          uid,
          members.map((old, i) => ({ next: named[i]!, old })),
          stayProof(members),
          [
            ...store.agentReceipts(receiptFor(200, body), audit({ checkin: members[0]!.id }), rate, previous, now),
            ...legacyGuard()
          ]
        );
        answer = { status: 200, body, replayed: false, limit };
        after = async () => {
          const fields = { ...by(), checkin: members[0]!.id, day: members[0]!.day };
          await record([
            ...(naming ? [{ kind: 'checkin.named', id: again(members[0]!.id), fields }] : []),
            ...(retagged ? [{ kind: 'checkin.tagged', id: again(members[0]!.id), fields }] : [])
          ]);
        };
      } else if (op === 'check-ins.delete') {
        const members = await checkInStay(await store.namedPlaces(uid));
        landed = await store.checkInWrites(
          uid,
          members.map((old) => ({ old })),
          stayProof(members),
          [
            ...store.agentReceipts(receiptFor(204, null), audit({ count: members.length }), rate, previous, now),
            ...legacyGuard()
          ]
        );
        answer = { status: 204, body: null, replayed: false, limit };
        after = async () => {
          await record([
            {
              kind: 'checkin.deleted',
              id: again(members[0]!.id),
              fields: { ...by(), day: members[0]!.day, count: members.length }
            }
          ]);
        };
      } else if (op === 'check-ins.delete-all') {
        if (args.confirm !== 'all')
          throw new ApiRefusal('invalid_request', 'Send ?confirm=all to delete every check-in.', { field: 'confirm' });
        const every: CheckIn[] = [];
        for (let before: string | undefined; ;) {
          const page = await store.checkInsBelow(uid, before, 500);
          every.push(...page.items);
          if (!page.more) break;
          before = String(every.at(-1)!.sk).slice('CHECKIN#'.length);
        }
        const count = (wiped ??= every.length),
          body = { deleted: count };
        landed = await store.checkInWrites(
          uid,
          every.map((old) => ({ old })),
          store.tokenProof(token, now, 'notes:all'),
          [...store.agentReceipts(receiptFor(200, body), audit({ count }), rate, previous, now), ...legacyGuard()]
        );
        answer = { status: 200, body, replayed: false, limit };
        after = async () => {
          if (count) await record([{ kind: 'checkin.deleted', id: again(tid), fields: { ...by(), count, all: true } }]);
        };
      } else if (op === 'check-ins.places.add') {
        const given = nameFrom(args.name),
          spot = spotOf({ lat: args.lat, lon: args.lon }),
          flag = ignoredFrom(args),
          tagging = tagsArg(args);
        if (!spot) throw new ApiRefusal('invalid_request', 'Send lat and lon in degrees.', { field: 'lat' });
        const places = await store.namedPlaces(uid),
          old = places.find((p) => sameName(p.name, given));
        if (!old && places.length >= NAMED_PLACES_MAX)
          throw new ApiRefusal('invalid_request', `An account remembers up to ${NAMED_PLACES_MAX} names. Forget one.`, {
            field: 'name'
          });
        const had = old?.spots.some((s) => s.lat === spot.lat && s.lon === spot.lon) ?? false;
        if (old && !had && old.spots.length >= NAMED_PLACE_SPOTS_MAX)
          throw new ApiRefusal('invalid_request', `A name holds up to ${NAMED_PLACE_SPOTS_MAX} spots.`, {
            field: 'name'
          });
        const id = old?.id ?? `p-${randomUUID().replace(/-/g, '')}`,
          was = old?.ignored === true,
          ignored = flag ?? was,
          flips = ignored !== was,
          // Tags sent join a remembered place's own (1.21.0).
          hadTags = old ? storedTags(old) : [],
          tags = tagging ? mergeTags(hadTags, tagging) : hadTags,
          gained = tags.length > hadTags.length,
          spotted = withIgnored(
            (old
              ? { ...old, spots: had ? old.spots : [...old.spots, spot], revision: Number(old.revision) + 1 }
              : {
                  pk: 'USER#' + uid,
                  sk: namedPlaceKey(id),
                  id,
                  name: given,
                  spots: [spot],
                  revision: 1
                }) as NamedPlace,
            ignored
          ),
          next = withTags(spotted, tags),
          writes = !had || flips || gained,
          status = old ? 200 : 201,
          // A place that gained tags says how many check-ins are there, to
          // offer tagging them (PATCH /v1/check-ins/places/{id}/check-ins).
          body = {
            place: {
              ...namedPlaceView(writes ? next : old!),
              ...(gained ? { check_ins: (await staysAtNext(store, uid, next)).length } : {})
            }
          };
        landed = await store.checkInWrites(
          uid,
          writes ? [{ next, ...(old ? { old } : {}) }] : [],
          store.tokenProof(token, now, 'notes:all'),
          [
            ...store.agentReceipts(receiptFor(status, body), audit({ place: id }), rate, previous, now),
            ...legacyGuard()
          ]
        );
        answer = { status, body, replayed: false, limit };
        after = async () => {
          await record([
            ...(had
              ? []
              : [
                  {
                    kind: 'checkin.place',
                    id: again(id),
                    fields: { ...by(), place: id, change: old ? 'spot' : 'added' }
                  }
                ]),
            ...(gained && old
              ? [{ kind: 'checkin.place', id: again(id), fields: { ...by(), place: id, change: 'tagged' } }]
              : []),
            ...(flips ? [ignoreEvent(id, ignored)] : [])
          ]);
        };
      } else if (op === 'check-ins.places.change' || op === 'check-ins.places.delete') {
        const places = await store.namedPlaces(uid),
          id = String(args.id),
          old = places.find((p) => p.id === id);
        if (!old) throw new ApiRefusal('not_found', NO_PLACE);
        const changing = op === 'check-ins.places.change',
          renaming = changing && Object.hasOwn(args, 'name'),
          flag = changing ? ignoredFrom(args) : undefined,
          tagging = changing ? tagsArg(args) : null;
        if (changing && !renaming && flag === undefined && !tagging)
          throw new ApiRefusal('invalid_request', 'Send name, ignored, tags, or any of them.', { field: 'name' });
        const given = renaming ? nameFrom(args.name) : null;
        if (given && places.some((p) => p.id !== id && sameName(p.name, given)))
          throw new ApiRefusal(
            'invalid_request',
            'Another remembered place has that name. Forget it, or add this spot to it with POST /v1/check-ins/places.',
            { field: 'name' }
          );
        const was = old.ignored === true,
          ignored = flag ?? was,
          // Tags sent are the place's whole list (1.21.0). Taking one off
          // leaves the check-ins already there as they are (call 6).
          hadTags = storedTags(old),
          tags = tagging ?? hadTags,
          gained = tags.some((t) => !hadTags.some((h) => h.key === t.key)),
          retagged = tagging !== null && JSON.stringify(tags) !== JSON.stringify(hadTags),
          next: NamedPlace | null = changing
            ? {
                ...withTags(withIgnored(old, ignored), tags),
                name: given ?? old.name,
                revision: Number(old.revision) + 1
              }
            : null,
          status = next ? 200 : 204,
          body = next
            ? {
                place: {
                  ...namedPlaceView(next as NamedPlace),
                  ...(gained ? { check_ins: (await staysAtNext(store, uid, next as NamedPlace)).length } : {})
                }
              }
            : null;
        landed = await store.checkInWrites(
          uid,
          [{ ...(next ? { next } : {}), old }],
          store.tokenProof(token, now, 'notes:all'),
          [
            ...store.agentReceipts(receiptFor(status, body), audit({ place: id }), rate, previous, now),
            ...legacyGuard()
          ]
        );
        answer = { status, body, replayed: false, limit };
        after = async () => {
          await record([
            ...(!changing || renaming
              ? [
                  {
                    kind: 'checkin.place',
                    id: again(id),
                    fields: { ...by(), place: id, change: changing ? 'renamed' : 'forgotten' }
                  }
                ]
              : []),
            ...(retagged
              ? [{ kind: 'checkin.place', id: again(id), fields: { ...by(), place: id, change: 'tagged' } }]
              : []),
            ...(changing && ignored !== was ? [ignoreEvent(id, ignored)] : [])
          ]);
        };
      } else if (op === 'check-ins.places.delete-check-ins') {
        // Delete existing check-ins here (Jamie, 2026-11-08): every stay at
        // the place, hidden or not, for the count the owner was shown. A
        // retry after part of it landed deletes the rest and answers the
        // first count. The place stays.
        const id = String(args.id),
          place = (await store.namedPlaces(uid)).find((p) => p.id === id);
        if (!place) throw new ApiRefusal('not_found', NO_PLACE);
        const { stays } = await staysAt(store, uid, id);
        if (wiped === undefined && stays.length !== args.count)
          throw new ApiRefusal(
            'revision_mismatch',
            'The check-ins there changed since you counted them. GET /v1/check-ins/places/{id} again for the count.',
            { count: stays.length }
          );
        const count = (wiped ??= stays.length),
          body = { deleted: count };
        landed = await store.checkInWrites(
          uid,
          stays.flat().map((old) => ({ old })),
          store.tokenProof(token, now, 'notes:all'),
          [
            ...store.agentReceipts(receiptFor(200, body), audit({ place: id, count }), rate, previous, now),
            ...legacyGuard()
          ]
        );
        answer = { status: 200, body, replayed: false, limit };
        after = async () => {
          if (count) await record([{ kind: 'checkin.deleted', id: again(id), fields: { ...by(), place: id, count } }]);
        };
      } else if (op === 'check-ins.places.tag-check-ins') {
        // Tag the check-ins already here (Jamie's call 6, 2026-11-08): the
        // tags sent join each stay at the place, hidden or not, for the count
        // the owner was shown. A retry finds the stays already tagged.
        const id = String(args.id),
          place = (await store.namedPlaces(uid)).find((p) => p.id === id);
        if (!place) throw new ApiRefusal('not_found', NO_PLACE);
        const added = tagsArg(args);
        if (!added?.length) throw new ApiRefusal('invalid_request', 'Send the tags to add, by name.', { field: 'tags' });
        if (!Number.isSafeInteger(args.count) || Number(args.count) < 0)
          throw new ApiRefusal('invalid_request', 'Send count, how many check-ins GET /v1/check-ins/places/{id} said are there.', {
            field: 'count'
          });
        const { stays } = await staysAt(store, uid, id);
        if (stays.length !== args.count)
          throw new ApiRefusal(
            'revision_mismatch',
            'The check-ins there changed since you counted them. GET /v1/check-ins/places/{id} again for the count.',
            { count: stays.length }
          );
        const { changes, count } = staysTagged(stays, added),
          tagged = (wiped ??= count),
          body = { tagged };
        landed = await store.checkInWrites(uid, changes, store.tokenProof(token, now, 'notes:all'), [
          ...store.agentReceipts(receiptFor(200, body), audit({ place: id, count: tagged }), rate, previous, now),
          ...legacyGuard()
        ]);
        answer = { status: 200, body, replayed: false, limit };
        after = async () => {
          if (tagged)
            await record([{ kind: 'checkin.tagged', id: again(id), fields: { ...by(), place: id, count: tagged } }]);
        };
      } else if (op === 'tags.pinned') {
        const pins = pinnedTags(args.pinned);
        if (!pins) throw new ApiRefusal('invalid_request', 'pinned is a list of up to 12 tags.', { field: 'pinned' });
        const old = Array.isArray(profile.pinned_tags) ? storedPins(profile) : null,
          row = await tagRow(store, uid, { ...profile, pinned_tags: pins }, today),
          body = { ...row };
        landed = await store.setPins(uid, pins, old, [
          ...store.tokenProof(token, now, 'notes:write'),
          ...store.agentReceipts(receiptFor(200, body), audit({}), rate, previous, now),
          ...legacyGuard()
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
            ...store.agentReceipts(receiptFor(status, body), audit({ count: changes.length }), rate, previous, now),
            ...legacyGuard()
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
      } else if (op === 'notes.media.remove') {
        const old = await own(),
          d = String(args.date),
          id = String(args.id),
          n = Number(args.n),
          had = (old.media as OAuthRow[] | undefined) ?? [],
          entry = had.find((m) => Number(m.n) === n);
        if (!entry) throw new ApiRefusal('not_found', 'That note has no file with that number.');
        if (had.length === 1 && !noteWords(String(old.text ?? '')))
          throw new ApiRefusal('text_required', 'A note with no words keeps its last file. Delete the note instead.');
        const at = iso(now),
          body = written(withoutFile(old, n, at), d, id);
        landed = await store.apiMediaRemove(
          old,
          n,
          at,
          receiptFor(200, body),
          audit({ date: d, note_id: id, files: 1 }),
          rate,
          previous,
          token,
          now,
          legacyGuard()
        );
        answer = { status: 200, body, replayed: false, limit };
        after = async () => {
          const ours = mediaKeys({ media: [entry] } as NoteRecord).filter((k) => k.startsWith(`media/${uid}/`));
          if (ours.length && context.objects) await Promise.allSettled(ours.map((k) => context.objects!.remove(k)));
          await record([
            {
              kind: 'note.files',
              id: again(id),
              fields: { via: 'token', token: name, ...(client ? { client } : {}), day: d, note: id, removed: 1 }
            }
          ]);
        };
      } else if (op === 'notes.place' || op === 'notes.place.clear') {
        const old = await own(),
          d = String(args.date),
          id = String(args.id),
          place = op === 'notes.place' ? placeFrom(args.place) : null,
          full: OAuthRow = { ...old };
        delete full[place ? 'place_cleared' : 'place'];
        Object.assign(full, place ? { place } : { place_cleared: true });
        const body = written(full, d, id);
        landed = await store.apiNotePlace(
          old,
          place,
          receiptFor(200, body),
          audit({ date: d, note_id: id }),
          rate,
          previous,
          token,
          now,
          legacyGuard()
        );
        answer = { status: 200, body, replayed: false, limit };
        after = async () => {
          let unlocked: Unlocked[] = [];
          if (profile.badges !== false) {
            try {
              unlocked = await unlockedBy(context.store, uid, profile, today, full, old, [], (f) =>
                (options.log ?? safeLog)(f)
              );
            } catch {
              (options.log ?? safeLog)({ event: 'badges-error', user: uid, date: d });
            }
            answer.body = { ...body, unlocked: unlocked.map((u) => ({ key: u.key, name: u.name })) };
          }
          await record([
            {
              kind: 'note.edited',
              id: again(id),
              fields: {
                via: 'token',
                token: name,
                ...(client ? { client } : {}),
                day: d,
                note: id,
                place: place ? 'set' : 'removed'
              }
            },
            ...badgeEvents(unlocked, 'token', d, id, client).map((e) => ({
              ...e,
              fields: { ...e.fields, token: name }
            }))
          ]);
          await keepWeather(d, true);
        };
      } else if (op === 'days.place' || op === 'days.place.clear') {
        const d = day(args.date);
        let place: OAuthRow | null = null;
        if (op === 'days.place') {
          // A day is a city; an exact spot is a note's (Jamie, 2026-10-24).
          const raw = args.place,
            city = object(raw) && raw.from === 'device' ? null : clean(raw);
          if (!city)
            throw new ApiRefusal('invalid_request', 'place is a city from GET /v1/places, sent back as it came.', {
              field: 'place'
            });
          place = { ...chosen(city) };
          delete place.from;
        }
        const status = place ? 200 : 204,
          body = place ? { date: d, place: placeView(place) } : null;
        landed = await store.apiDayPlace(uid, d, place, [
          ...store.tokenProof(token, now, 'notes:all'),
          ...store.agentReceipts(receiptFor(status, body), audit({ date: d }), rate, previous, now),
          ...legacyGuard()
        ]);
        answer = { status, body, replayed: false, limit };
        after = async () => {
          await record([
            {
              kind: place ? 'place.set' : 'place.removed',
              id: again(d),
              fields: { via: 'token', token: name, ...(client ? { client } : {}), day: d }
            }
          ]);
          await keepWeather(d, true);
        };
      } else if (op === 'notes.delete') {
        const old = await own(),
          d = String(args.date),
          id = String(args.id),
          // Everything behind the note, as the web's delete removes it: the
          // email it came in (raw/) and every file and small copy.
          files = [
            ...new Set([
              ...(String(old.raw_key ?? '').startsWith('raw/') ? [String(old.raw_key)] : []),
              ...mediaKeys(old as NoteRecord),
              ...thumbKeys(old as NoteRecord)
            ])
          ];
        landed = await store.apiNoteDelete(
          old,
          receiptFor(204, null),
          audit({ date: d, note_id: id }),
          rate,
          previous,
          token,
          now,
          legacyGuard()
        );
        answer = { status: 204, body: null, replayed: false, limit };
        after = async () => {
          // Only this account's: its files, and the email behind the note.
          const ours = files.filter((k) => k.startsWith(`media/${uid}/`) || k.startsWith('raw/'));
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
        let words = op === 'notes.media' ? '' : text(args, withFiles),
          old: OAuthRow | null = null,
          typed = now,
          d: string,
          place: OAuthRow | null = null;
        // The tags field (1.21.0), checked before any file is claimed.
        const given = tagsArg(args);
        if (op === 'notes.create') {
          if (Object.hasOwn(args, 'written_at')) {
            const at = String(args.written_at),
              seconds = Date.parse(at) / 1000;
            if (!realTime(at) || !Number.isFinite(seconds))
              throw new ApiRefusal('invalid_request', 'written_at is an RFC 3339 time.', { field: 'written_at' });
            if (seconds > now + 300)
              throw new ApiRefusal('invalid_request', 'written_at is in the future.', { field: 'written_at' });
            // A day and a half before the birthday began in UTC is before it
            // in every zone; checked first, since a time near year 1 is past
            // what a zone's calendar (localDay) can name.
            if (seconds < Date.parse(`${birthday}T00:00:00Z`) / 1000 - 1.5 * 86400)
              throw new ApiRefusal('date_out_of_range', 'Choose a time from your birthday through now.', {
                field: 'written_at'
              });
            // A minute or two ahead of this clock is still now.
            typed = Math.min(Math.floor(seconds), now);
          }
          // Words typed offline file to the day they were typed, unless a date
          // says otherwise.
          if (Object.hasOwn(args, 'date')) d = day(args.date);
          else {
            d = localDay(typed, tz);
            if (d < birthday)
              throw new ApiRefusal('date_out_of_range', 'Choose a time from your birthday through now.', {
                field: 'written_at'
              });
          }
          if (Object.hasOwn(args, 'place')) {
            place = placeFrom(args.place);
          }
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
          if (op === 'notes.media') words = String(old.text ?? '');
        }
        tooLong(words);
        const before = (old?.media as OAuthRow[] | undefined) ?? [];
        if (withFiles && Array.isArray(args.uploads) && before.length + args.uploads.length > MAX_FILES)
          throw new ApiRefusal(
            'invalid_request',
            `A note can hold ${MAX_FILES} files and this one has ${before.length}; send the rest with another note.`,
            { field: 'uploads' }
          );
        if (withFiles && !claimed) {
          if (!context.objects) throw new Error('Files service missing');
          try {
            claimed = await claimUploads(context.objects, uid, args.uploads, 'api');
          } catch (error) {
            if (error instanceof ApiError) throw uploadRefusal(error);
            throw error;
          }
        }
        // Numbered after the note's last file, as the web numbers them.
        const first = nextFile(old),
          added = (claimed?.entries ?? []).map((f, i) => ({ n: first + i, ...f }));
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
              version: computeVersion(birthday, d).toString(),
              ...(place ? { place } : {}),
              ...(args.markup === RICH ? { markup: RICH } : {})
            };
        Object.assign(note, {
          text: words,
          // The tags field, then the text's hashtags; without the field an
          // edit or append keeps the tags the old words didn't give it.
          ...(() => {
            const tags = noteTags(words, given, old);
            return { tags: tags.map((t) => t.key), tag_names: tags.map((t) => t.name) };
          })(),
          // New files change no words, so the links keep the titles they have.
          links:
            op === 'notes.media'
              ? ((old?.links as Link[] | undefined) ?? [])
              : await collect(words, {
                  keep: old?.links as Link[] | undefined,
                  fetch: titleOnce,
                  // A note's markup is its own, from its writing; an edit
                  // keeps it, as the web's does.
                  ...(isRich(old ?? note) ? { rich: true } : {})
                }),
          revision: Number(old?.revision ?? 0) + 1
        });
        if (old) note.updated_at = iso(now);
        if (added.length) note.media = [...before, ...added];
        const id = String(note.sk).split('#').slice(2).join('#'),
          full = { ...old, ...note },
          body = written(full, d, id);
        const status = old ? 200 : 201;
        try {
          landed = await store.apiNoteCommit(
            note,
            old,
            receiptFor(status, body),
            audit({ date: d, note_id: id, ...(added.length ? { files: added.length } : {}) }),
            rate,
            previous,
            token,
            now,
            old && added.length ? added : undefined,
            legacyGuard()
          );
        } catch (error) {
          unsure = true;
          throw error;
        }
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
            // As the web records them: new files on a note are note.files.
            op === 'notes.media'
              ? {
                  kind: 'note.files',
                  id: again(id),
                  fields: {
                    via: 'token',
                    token: name,
                    ...(client ? { client } : {}),
                    day: d,
                    note: id,
                    added: added.length
                  }
                }
              : {
                  kind: old ? 'note.edited' : 'note.added',
                  id: old ? again(id) : id,
                  fields: {
                    via: 'token',
                    token: name,
                    ...(client ? { client } : {}),
                    day: d,
                    note: id,
                    version: full.version,
                    ...(added.length ? { files: added.length } : {})
                  }
                },
            ...badgeEvents(unlocked, 'token', d, id, client).map((e) => ({
              ...e,
              fields: { ...e.fields, token: name }
            }))
          ]);
          if (place) await keepWeather(d, false);
        };
      }
      if (landed) {
        committed = true;
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
  } finally {
    if (claimed && context.objects) {
      const objects = context.objects;
      if (committed) await Promise.allSettled(claimed.pending.map((p) => objects.remove(p.key, p.version)));
      else if (!(unsure && (await mayHaveLanded(store, uid, receiptKey, hash))))
        await dropCopies(objects, claimed.entries);
    }
  }
}

/** Whether a commit whose answer was lost wrote this request's receipt. A
 * failed read counts as landed, as for an agent (workers/capture.ts). */
async function mayHaveLanded(store: ApiStore, uid: string, key: string, hash: string): Promise<boolean> {
  try {
    const receipt = await store.mcpGet('USER#' + uid, key);
    return Boolean(receipt && receipt.request_hash === hash);
  } catch {
    return true;
  }
}
