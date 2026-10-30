/** The activity log (docs/WEB-APP.md, Activity; Jamie, 2026-10-20: "a full
 * log of any activity happening in release notes"): one row for each thing
 * that happened to an account, newest first, kept for the life of the account
 * and in the export. A row says when, through what (the channel, or the
 * assistant by its client's name), what happened, and the day, note or date
 * it touched; it never copies the words of a note or an Upcoming entry. A
 * mail row keeps what the mail log kept: its subject, a sender that was not
 * the owner, and the words only once that sender was proven.
 *
 * Rows live at USER#<owner> / ACTIVITY#<ISO time>#<kind>#<id>. An
 * assistant's reads are summed into one row a connection a local day, which
 * the MCP reader writes; since it may not write USER# rows, that row lives at
 * MCPMETA#<owner> / ACTIVITY#<the day's first instant>#reads#<connection>,
 * and readers merge the two partitions by key.
 *
 * Every other row is written after the change it records, with the account
 * proof (packages/backend/activity.ts): a failed write never fails the
 * change, and is logged as activity-unrecorded. The kinds, and the fields
 * each carries besides `via` (web, email, assistant or import) and `client`
 * (an assistant's name):
 *
 * - note.added, note.edited, note.deleted: `day`, `note` (its id), `files`
 *   (a count), `version`; note.edited also `place` (set or removed) when
 *   it was where the note was that changed, never the place; note.files:
 *   `day`, `note`, `added`. A note filed by email is its mail row.
 * - transcript.added: `day`, `note`, `file` (its place in the note),
 *   `empty` (nothing could be made out); description.added: `day`, `note`,
 *   `photos` (how many that pass described). Never the words.
 * - badge.earned: `badge`, `key`, `name`, `version`, `day`, `note`, from a
 *   save on the web, by an assistant or by email; a giving year's (via
 *   `weekly-thing`, domain/giving.ts) has no `day` or `note`, nor has one
 *   earned outside notes (a profile photo, feedback sent or marked done
 *   (via `admin`), a book, a date added to Upcoming, an easter egg; docs/BADGES.md).
 * - import.notes (one a run that imported anything, even one that stopped
 *   partway): `app` (dayone), `notes`, `files` (of those notes).
 * - email.sent: `day`, `version`; reminder (one per reminder due that
 *   morning, those past the email's three included): `upcoming`, `when`
 *   (as the email said it), `day`.
 * - place.set, place.removed (a day's own place): `day`, never the place.
 * - upcoming.added, upcoming.changed, upcoming.removed: `upcoming` (its id).
 *   The title is joined when read, never stored: the web always shows it, an
 *   assistant only with the upcoming scope.
 * - settings.changed: `changes`, each `{field, from, to}`.
 * - pause.set: `from`, `through`; pause.ended: `from`, `through` (the last
 *   paused day, or null when it ended before it began).
 * - status.stopped: `reason` (unsubscribed, or bounce or complaint from the
 *   mail service); status.restarted: `reason` (why it had stopped).
 * - signin: `how` (link or code). export.words: `format`; export.zip;
 *   export.book: `from`, `to` (the book's first and last day), and
 *   `commentary` when it asked for Claude's.
 * - photo.set, photo.changed, photo.removed (the profile photo,
 *   backend/profile-photo.ts): never the image.
 * - address.created, address.replaced; calendar.created, calendar.replaced,
 *   calendar.removed: never the address or link.
 * - connection.added: `connection`, `client`, `scopes`; connection.changed:
 *   `connection`, `client`, `from`, `to`; connection.removed: `connection`,
 *   `client`, `reason` (owner; client, when it revoked its own token; or
 *   token-reuse, when a used refresh token, or an app's sign-in code, came
 *   back and ended it). An API token's rows also carry `token`, its name
 *   (docs/API.md); one an app signed in for (Phase 5) is added with `app`,
 *   the name the app registered.
 * - Through an API token (via `token`): note rows and the badges they earn
 *   carry `token`, the token's name, and `client`, the product its
 *   User-Agent named; its reads row too, and settings.changed when it
 *   changed the pinned tags. From API 1.4.0 (2026-10-30) every row a token
 *   wrote, and its reads row, carries `token_id` too, the token's id, which
 *   a name is not; rows written before then have none.
 * - feedback.filed: `feedback` (its id), `feedback_kind` (bug, idea, question or
 *   other), `follows` (the item it follows, if any), `screenshots` (a
 *   count); feedback.answered (via `admin`): `feedback`, `status` (what the
 *   answer set), `mail` (sent, failed or not-sent). Never the words.
 * - egg.found (via `web`): `egg`, the easter egg found (developer or rtfm,
 *   domain/eggs.ts), one row an egg ever, written by `POST /api/eggs`.
 * - account.created. */
import { codePointSlice } from './unicode.ts';

export const ACTIVITY = 'ACTIVITY#';
/** Above every activity key ('$' follows '#'). */
export const ACTIVITY_END = 'ACTIVITY$';

/** What a row's kind starts with, before any dot ("note.added" is a note
 * row), for filtering. */
export const ACTIVITY_FAMILIES = [
  'mail',
  'reads',
  'note',
  'transcript',
  'description',
  'import',
  'badge',
  'email',
  'reminder',
  'place',
  'upcoming',
  'settings',
  'pause',
  'status',
  'signin',
  'export',
  'photo',
  'address',
  'calendar',
  'connection',
  'feedback',
  'egg',
  'account'
] as const;
export const familyOf = (kind: string): string => kind.split('.')[0]!;

type Row = Record<string, unknown>;

/** Something to record: its kind, an id that keeps its key unique, and its
 * fields (never the words of a note or an Upcoming entry). */
export interface ActivityEvent {
  kind: string;
  id: string;
  fields?: Row;
}
export function activityRow(user: string, at: string, e: ActivityEvent): Row {
  return { ...e.fields, pk: `USER#${user}`, sk: activityKey(at, e.kind, e.id), kind: e.kind, at };
}

/** ISO time to the millisecond, as every activity key carries it. */
export const activityTime = (epochSeconds: number): string => new Date(Math.round(epochSeconds * 1000)).toISOString();

export function activityKey(at: string, kind: string, id: string): string {
  return `${ACTIVITY}${at}#${kind}#${id}`;
}

/** A row's id, which is also where a page of older rows starts. */
export const activityId = (sk: string): string => sk.slice(ACTIVITY.length);

const MAIL = ['message', 'received_at', 'via', 'day', 'version', 'subject', 'outcome', 'reason', 'sender', 'text'];
const READS = ['day', 'via', 'client', 'token', 'token_id', 'connection', 'calls', 'tools', 'errors', 'last_at'];

/** A row as its owner sees it, on the web and in the export: no table keys,
 * revisions or expiry. */
export function activityView(row: Row): Row {
  const kind = String(row.kind),
    pick = (fields: string[]) => Object.fromEntries(fields.filter((k) => row[k] != null).map((k) => [k, row[k]])),
    head = { id: activityId(String(row.sk)), at: String(row.at), kind };
  if (kind === 'mail')
    return {
      ...head,
      ...pick(MAIL),
      subject: String(row.subject ?? ''),
      reason: row.reason ?? null,
      sender: row.sender ?? null,
      text: row.text ?? null,
      attempts: Number(row.attempts ?? 0),
      notified: Boolean(row.notified_at)
    };
  if (kind === 'reads') return { ...head, ...pick(READS), calls: Number(row.calls ?? 0) };
  // Every other row holds only what its kind records (above).
  return { ...head, ...Object.fromEntries(Object.entries(row).filter(([k]) => !INTERNAL.has(k))) };
}
const INTERNAL = new Set(['pk', 'sk', 'kind', 'at', 'revision', 'expires_at']);

/** A row naming an Upcoming date (`upcoming`, its id) with the date's
 * title, joined when read: null once the date is gone. */
export function titled(view: Row, titles: ReadonlyMap<string, string>): Row {
  return typeof view.upcoming === 'string' ? { ...view, title: titles.get(view.upcoming) ?? null } : view;
}

/** What an agent reads: the owner's view, with a mail row's subject cut at
 * 300 code points and its words at 2,000, and `cut` saying so. */
export function agentActivityView(row: Row): Row {
  const view = activityView(row);
  if (view.kind !== 'mail') return view;
  const subject = codePointSlice(String(view.subject), 0, 300),
    text = view.text == null ? null : codePointSlice(String(view.text), 0, 2000),
    cut = subject !== view.subject || text !== view.text;
  return { ...view, subject, text, ...(cut ? { cut: true } : {}) };
}

const MAIL_KEPT = ['message', 'received_at', 'via', 'day', 'version', 'outcome', 'reason'];

/** What a token with the `activity` scope reads (docs/API.md): the owner's
 * view with every word taken out. A mail row keeps neither subject, words
 * nor sender; a settings change names only its fields. */
export function tokenActivityView(row: Row): Row {
  const view = activityView(row);
  if (view.kind === 'mail')
    return {
      id: view.id,
      at: view.at,
      kind: view.kind,
      ...Object.fromEntries(MAIL_KEPT.filter((k) => view[k] != null).map((k) => [k, view[k]]))
    };
  if (view.kind === 'settings.changed' && Array.isArray(view.changes))
    return {
      ...view,
      changes: (view.changes as Row[]).map((c) => ({ field: c && typeof c === 'object' ? c.field : null }))
    };
  return view;
}
