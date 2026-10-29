import { runtimeSelfTest } from './runtime.ts';
/** Private delegated writer: no HTTP, mail or models. Every commit atomically
 * proves the live family/profile, receipt, quota and note revision. Files an
 * agent sends (server/mcp/files.ts) are kept under media/<user>/files/ first,
 * as a web upload's checked copy is, and removed if no note takes them. A
 * feedback screenshot, stripped of its metadata, is put under the owner's
 * media/<owner>/feedback/ and never removed (packages/backend/feedback.ts). */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createObjects } from '../packages/backend/aws.ts';
import type { Objects } from '../packages/backend/services.ts';
import { MAX_FILES } from '../packages/backend/media.ts';
import { dropFiles, inlineFiles, keepFiles, type InlineFile } from '../server/mcp/files.ts';
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
import {
  agentFeedbackSummary,
  agentUpcomingView,
  editRevision,
  Reader,
  type ReaderContext,
  type ReaderStore
} from '../server/mcp/reader.ts';
import { FEEDBACK_TOOLS, TOOLS, UPCOMING_TOOLS, WRITE_TOOLS, scopesFor } from '../server/mcp/contract.ts';
import { fileFeedback, newFeedbackId, type FeedbackStore } from '../packages/backend/feedback.ts';
import { InlineImageError, inlineImages } from '../packages/backend/inline-images.ts';
import { feedbackFields, SCREENSHOTS_MAX } from '../packages/domain/feedback.ts';
import { ApiError } from '../packages/backend/sessions.ts';
import { chosen, search, type City } from '../packages/backend/places.ts';
import {
  prepareUpcomingBatch,
  resolvePlace,
  type UpcomingBatch,
  type UpcomingChange
} from '../packages/backend/upcoming.ts';
import { occurrence, type UpcomingEntry } from '../packages/domain/upcoming.ts';
import { activityLog, again, badgeEvents, recordActivity, upcomingEvents } from '../packages/backend/activity.ts';
import { addedEvents, earnedBy, freshEvent, unlockedBy } from '../packages/backend/badges.ts';
import { safeLog } from '../packages/backend/services.ts';
import { activityKey, activityTime } from '../packages/domain/activity.ts';
import type { Unlocked } from '../packages/domain/badges.ts';
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
export interface CaptureStore extends ReaderStore, Omit<FeedbackStore, 'mcpProfile' | 'putActivity'> {
  agentFiling(receipt: OAuthRow, audit: OAuthRow, now: number): Ops;
  upcomingBatch(uid: string, changes: readonly UpcomingChange[], extra: Ops): Promise<{ ok: boolean; applied: number }>;
  agentProof(family: OAuthRow, now: number, scope: string | readonly string[]): Ops;
  familyProof(family: OAuthRow, now: number, scope: string | readonly string[]): Ops;
  agentReceipts(receipt: OAuthRow, audit: OAuthRow, rate: OAuthRow, previous: OAuthRow | null, now: number): Ops;
  putActivity(user: string, rows: readonly OAuthRow[]): Promise<boolean>;
  captureCommit(
    note: OAuthRow,
    old: OAuthRow | null,
    receipt: OAuthRow,
    audit: OAuthRow,
    rate: OAuthRow,
    previous: OAuthRow | null,
    family: OAuthRow,
    now: number,
    added?: readonly OAuthRow[]
  ): Promise<boolean>;
}
export interface CaptureContext extends ReaderContext {
  store: CaptureStore;
  /** City search for a destination written as text; Open-Meteo by default. */
  geocode?: (q: string) => Promise<City[]>;
  /** The private bucket, for files an agent sends; nothing else is read. */
  objects?: Objects;
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
/** Daily writes an account takes from all its connections, by tool. */
const CAPS: Record<string, number> = { notes_create: 20, notes_append: 50, notes_edit: 50, notes_attach: 20 };
/** The connection's own notes: an append, a rewrite or new files go nowhere else. */
const OWN: Record<string, string> = {
  notes_append: 'Append only to a note created by this same connection; create a new note for anything else.',
  notes_edit:
    'Rewrite only a note created by this same connection; the owner edits their own notes on the web. Create a new note instead, or ask the user to change it.',
  notes_attach: 'Add files only to a note created by this same connection; create a new note with the files instead.'
};
export async function writeCapture(
  context: CaptureContext,
  family: OAuthRow,
  name: string,
  args: Arguments,
  options: CaptureOptions = {}
): Promise<OAuthRow> {
  const granted = String(family.scope).split(/\s+/),
    lacking = scopesFor(name, args).filter((s) => !granted.includes(s));
  if (lacking.includes('notes:write'))
    throw new ToolError('scope_required', 'Reconnect and explicitly approve adding agent notes.');
  if (lacking.length)
    throw new ToolError(
      'scope_required',
      'Ask the user to allow adding files for this connection under Settings, Connected agents, or to reconnect and approve it; or write the note without files.'
    );
  // Checked whole now, and kept only once the rest of the write has passed.
  const files: InlineFile[] = Object.hasOwn(args, 'files') ? inlineFiles(args.files) : [];
  const uid = String(family.user_id),
    fid = String(family.id),
    key = 'CAPTURE#' + fid + '#' + digest(String(args.idempotency_key)),
    hash = fingerprint({ tool: name, arguments: args }),
    reader = await Reader.create(context, family),
    titles = new Map<string, PageMeta | null>();
  let place: OAuthRow | undefined,
    kept: OAuthRow[] | null = null,
    committed = false,
    // A commit that threw may still have landed (a lost response).
    unsure = false;
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
  try {
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
      let text = typeof args.text === 'string' ? pythonTrim(args.text.replace(/\r\n/g, '\n')) : '',
        old: OAuthRow | null = null;
      if (name !== 'notes_attach' && !text && !files.length)
        throw new ToolError(
          'invalid_arguments',
          name === 'notes_create' ? 'Write some note text, or send files.' : 'Write some note text.'
        );
      if (name !== 'notes_create') {
        old = await reader.note(args);
        if (old.author !== 'assistant' || old.connection !== fid || old.client_id !== family.client_id)
          throw new ToolError('forbidden_not_author', OWN[name]!);
        // A rewrite replaces only the words its author read: a change on the
        // web (or by this connection) since then refuses it, never overwrites.
        if (name === 'notes_edit' && editRevision(old) !== args.revision)
          throw new ToolError(
            'conflict',
            'The note changed since you read it: read it again with notes_get_note and redo the edit from its current text, with its new revision.'
          );
        if (name === 'notes_append') text = String(old.text ?? '') + '\n\n' + text;
        if (name === 'notes_attach') text = String(old.text ?? '');
      }
      const before = (old?.media as OAuthRow[] | undefined) ?? [];
      if (before.length + files.length > MAX_FILES)
        throw new ToolError(
          'too_many_files',
          `A note can hold ${MAX_FILES} files and this one has ${before.length}; create another note for the rest.`
        );
      if (codePointLength(text) > MAX_NOTE)
        throw new ToolError('too_long', 'A note can have at most 20,000 characters; create another note.');
      // A city the user named, found once, as the web's Where finds one.
      if (!old && typeof args.place === 'string') place ??= await namedPlace(args.place, context.geocode ?? search);
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
            version: computeVersion(reader.birthday, day).toString(),
            ...(place ? { place } : {})
          };
      Object.assign(note, {
        text,
        tags: found(text),
        // New files change no words, so the links keep the titles they have.
        links:
          name === 'notes_attach'
            ? ((old?.links as Link[] | undefined) ?? [])
            : await collect(text, { keep: old?.links as Link[] | undefined, fetch: titleOnce }),
        revision: Number(old?.revision ?? 0) + 1
      });
      if (old) note.updated_at = iso(context.now);
      const rateKey = `WRITERATE#${name}#${Math.floor(context.now / 86400)}`,
        previous = await context.store.mcpGet('MCPMETA#' + uid, rateKey),
        count = Number(previous?.n ?? 0);
      if (count >= CAPS[name]!)
        throw new ToolError(
          'rate_limited',
          'Try again after this UTC day ends; exact retries of completed writes are still safe.'
        );
      if (files.length && !kept) {
        if (!context.objects) throw new Error('Files service missing');
        kept = await keepFiles(context.objects, uid, files);
      }
      // Numbered after the note's last file, as the web numbers them.
      const first = Math.max(0, ...before.map((m) => Number(m.n))) + 1,
        added = (kept ?? []).map((f, i) => ({ n: first + i, ...f }));
      if (added.length) note.media = [...before, ...added];
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
          ...(added.length ? { files: added.length } : {}),
          expires_at: context.now + 14 * 86400
        };
      let landed: boolean;
      try {
        landed = await context.store.captureCommit(
          note,
          old,
          newReceipt,
          audit,
          rate,
          previous,
          family,
          context.now,
          old && added.length ? added : undefined
        );
      } catch (error) {
        unsure = true;
        throw error;
      }
      if (landed) {
        committed = true;
        await recordNote(
          context,
          family,
          name,
          note,
          old,
          day,
          reader.profile,
          reader.today,
          added.length,
          options.log
        );
        return { note: shown, replayed: false };
      }
      const current = await context.store.mcpGet('OAUTHFAMILY#' + fid),
        profile = await context.store.mcpProfile(uid);
      if (
        !live(current, context.now) ||
        !profile ||
        profile.mcp_deleting ||
        current.revision !== family.revision ||
        scopesFor(name, args).some((s) => !String(current.scope).split(/\s+/).includes(s))
      )
        throw new ToolError('scope_required', 'This connection changed or was disconnected; reconnect before writing.');
    }
    throw new ToolError('busy', 'Try again shortly with exactly the same idempotency_key and arguments.');
  } finally {
    // A file no note took; one already numbered into a committed note stays.
    // After a commit that threw, only this write's receipt, read strongly,
    // says whether the note took them; if that cannot be read, they stay.
    if (kept && !committed && !(unsure && (await mayHaveLanded(context, uid, key, hash))))
      await dropFiles(context.objects!, kept);
  }
}
/** Whether a commit whose answer was lost wrote this request's receipt. A
 * failed read counts as landed: an orphan file beats a note without its file. */
async function mayHaveLanded(context: CaptureContext, uid: string, key: string, hash: string): Promise<boolean> {
  try {
    const receipt = await context.store.mcpGet('USER#' + uid, key);
    return Boolean(receipt && receipt.request_hash === hash);
  } catch {
    return true;
  }
}
/** A note's place from a city written as text, kept as one chosen on the
 * web is. */
async function namedPlace(text: string, geocode: (q: string) => Promise<City[]>): Promise<OAuthRow> {
  let city: City | null;
  try {
    city = await resolvePlace(text, geocode);
  } catch (error) {
    if (error instanceof ApiError && error.error === 'places-failed')
      throw new ToolError('temporarily_unavailable', 'The city search is unavailable; try again shortly.');
    throw error;
  }
  if (!city)
    throw new ToolError(
      'invalid_arguments',
      'place is a city the search knows, like "Zürich" or "Paris, Texas"; leave it out if unsure.'
    );
  return chosen(city);
}
/** A saved note and the badges it earned, in the owner's activity log; the
 * badges are not marked seen, so the email still tells of them. */
async function recordNote(
  context: CaptureContext,
  family: OAuthRow,
  name: string,
  note: OAuthRow,
  old: OAuthRow | null,
  day: string,
  profile: OAuthRow,
  today: string,
  files: number,
  log?: SafeLog
): Promise<void> {
  const uid = String(family.user_id),
    id = String(note.sk).split('#').slice(2).join('#'),
    edit = name !== 'notes_attach' && old,
    row = name === 'notes_attach' || old ? again(id) : id,
    // A note an agent edited earns Pair programming too (docs/BADGES.md).
    fresh = edit
      ? [freshEvent('pair', activityKey(activityTime(context.now), 'note.edited', row), context.now, profile.tz)]
      : [];
  let unlocked: Unlocked[] = [];
  if (profile.badges !== false)
    try {
      unlocked = await unlockedBy(context.store, uid, profile, today, note, old, fresh, (f) => (log ?? safeLog)(f));
    } catch {
      (log ?? ((f) => console.log(JSON.stringify(f))))({ event: 'badges-error', user: uid, date: day });
    }
  await recordActivity(
    context.store,
    uid,
    context.now,
    [
      // As the web records them: new files are note.files, with a count.
      name === 'notes_attach'
        ? {
            kind: 'note.files',
            id: row,
            fields: { via: 'assistant', client: family.client_name, day, note: id, added: files }
          }
        : {
            kind: old ? 'note.edited' : 'note.added',
            id: row,
            fields: {
              via: 'assistant',
              client: family.client_name,
              day,
              note: id,
              version: note.version,
              ...(files ? { files } : {})
            }
          },
      ...badgeEvents(unlocked, 'assistant', day, id, family.client_name)
    ],
    activityLog(context.now, log)
  );
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
  args: Arguments,
  options: CaptureOptions = {}
): Promise<OAuthRow> {
  if (!String(family.scope).split(/\s+/).includes('upcoming'))
    throw new ToolError(
      'scope_required',
      'Ask the user to allow Upcoming for this connection under Settings, Connected agents, or to reconnect and approve it.'
    );
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
    if (outcome.ok) {
      // Dates added count toward the Roadmap: rows only, told in the email.
      const won = await earnedBy(
        context.store,
        uid,
        reader.profile,
        context.now,
        addedEvents(changes, context.now, reader.profile.tz),
        { via: 'assistant', client: family.client_name, log: (f) => (options.log ?? safeLog)(f) }
      );
      await recordActivity(
        context.store,
        uid,
        context.now,
        [...upcomingEvents(changes, 'assistant', family.client_name), ...won.events],
        activityLog(context.now, options.log)
      );
      return { ...shown, ...flag, replayed: false };
    }
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
const SCREENSHOT_HINTS: Record<string, string> = {
  'image-count': 'Send at most 3 screenshots.',
  'image-type': 'A screenshot is image/png, image/jpeg or image/webp.',
  'image-data': 'A screenshot is base64 of a whole PNG, JPEG or WebP file, without a data: prefix.',
  'image-too-big': 'Each screenshot can be at most 768 KB decoded; send a smaller one, a JPEG, or crop it.'
};
const FIELD_HINTS: Record<string, string> = {
  kind: 'kind is bug, idea, question or other.',
  text: 'Write what to tell Jamie.',
  'too-long': 'Feedback can have at most 4,000 characters; send the rest as a follow-up.',
  follows: 'follows is the id of an earlier item from notes_my_feedback.'
};
/** Feedback filed for the user (notes_send_feedback): the item, the
 * account's daily count (shared with the web), the receipt, the
 * content-free audit and the live grant (notes:read) in one transaction. */
export async function writeFeedback(
  context: CaptureContext,
  family: OAuthRow,
  name: string,
  args: Arguments
): Promise<OAuthRow> {
  const uid = String(family.user_id),
    fid = String(family.id),
    key = 'CAPTURE#' + fid + '#' + digest(String(args.idempotency_key)),
    hash = fingerprint({ tool: name, arguments: args }),
    fields = feedbackFields(args);
  if (typeof fields === 'string')
    throw new ToolError('invalid_arguments', FIELD_HINTS[fields] ?? 'Check the parameters.');
  let screenshots;
  try {
    screenshots = inlineImages(args.screenshots, { max: SCREENSHOTS_MAX });
  } catch (error) {
    if (!(error instanceof InlineImageError)) throw error;
    throw new ToolError(
      'invalid_arguments',
      (error.index >= 0 ? `screenshots[${error.index}]: ` : '') + SCREENSHOT_HINTS[error.reason]!
    );
  }
  if (screenshots.length && !context.objects) throw new Error('Objects service missing');
  const profile = await context.store.mcpProfile(uid);
  for (let attempt = 0; attempt < 5; attempt++) {
    const receipt = await context.store.mcpGet('USER#' + uid, key);
    if (live(receipt, context.now)) {
      if (receipt.request_hash !== hash)
        throw new ToolError(
          'duplicate_idempotency_key',
          'Use a new key for a different operation; reuse the original key only for an exact retry.'
        );
      return { feedback: JSON.parse(String(receipt.result)), replayed: true };
    }
    const id = newFeedbackId(),
      audit = {
        pk: 'MCPMETA#' + uid,
        sk: `LOG#${String(context.now).padStart(12, '0')}#${randomUUID().replace(/-/g, '')}`,
        at: context.now,
        tool: name,
        outcome: 'ok',
        connection: fid,
        client: family.client_name,
        feedback_id: id,
        expires_at: context.now + 14 * 86400
      };
    // Put only: the role may not delete under feedback/, and a commit whose
    // answer was lost may still have kept the item that names the files.
    const objects = context.objects,
      putOnly = { put: objects ? objects.put.bind(objects) : async () => undefined };
    const outcome = await fileFeedback(
      {
        store: context.store,
        objects: putOnly,
        now: context.now,
        // Issue opened: rows only, told in the email.
        ...(profile ? { badges: { store: context.store, profile, seen: false } } : {})
      },
      uid,
      { ...fields, screenshots, via: 'assistant', client: String(family.client_name ?? '') || null, connection: fid },
      (item) => [
        ...context.store.agentProof(family, context.now, 'notes:read'),
        ...context.store.agentFiling(
          {
            pk: 'USER#' + uid,
            sk: key,
            request_hash: hash,
            result: JSON.stringify(agentFeedbackSummary(item)),
            expires_at: context.now + 86400
          },
          audit,
          context.now
        )
      ],
      id
    );
    if (outcome.ok) return { feedback: agentFeedbackSummary(outcome.item), replayed: false };
    if (outcome.reason === 'limit')
      throw new ToolError(
        'rate_limited',
        'The account has sent 10 items of feedback today; try again after this UTC day ends.'
      );
    if (outcome.reason === 'follows')
      throw new ToolError('not_found', "follows names no item of the user's; read notes_my_feedback for ids.");
    if (outcome.reason === 'too-many') throw new ToolError('invalid_arguments', SCREENSHOT_HINTS['image-count']!);
    const current = await context.store.mcpGet('OAUTHFAMILY#' + fid),
      now = await context.store.mcpProfile(uid);
    if (
      !live(current, context.now) ||
      !now ||
      now.mcp_deleting ||
      current.revision !== family.revision ||
      !String(current.scope).split(/\s+/).includes('notes:read')
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
    return await (FEEDBACK_TOOLS.has(name)
      ? writeFeedback(context, family, name, args)
      : UPCOMING_TOOLS.has(name)
        ? writeUpcoming(context, family, name, args, options)
        : writeCapture(context, family, name, args, options));
  } catch (error) {
    if (error instanceof ToolError) return { error: error.code, next_step: error.nextStep };
    failure(context.now, uid, options.log, error);
    return {
      error: 'temporarily_unavailable',
      next_step: 'Try again shortly with exactly the same idempotency_key and arguments.'
    };
  }
}
let runtimeStore: Store | undefined, runtimeObjects: Objects | undefined;
export async function handler(event: unknown): Promise<OAuthRow> {
  if (runtimeSelfTest(event)) return runtimeSelfTest(event)!;
  runtimeStore ??= new Store(
    DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' }), {
      marshallOptions: { removeUndefinedValues: true }
    }),
    process.env.TABLE ?? process.env.TABLE_NAME ?? ''
  );
  runtimeObjects ??= createObjects(process.env.MAIL_BUCKET ?? '', process.env.AWS_REGION ?? 'us-east-1');
  return captureNote(event, {
    store: runtimeStore,
    objects: runtimeObjects,
    origin: process.env.WEB_ORIGIN ?? '',
    now: Math.floor(Date.now() / 1000)
  });
}
