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
 * and readers merge the two partitions by key. */
import { codePointSlice } from './unicode.ts';

export const ACTIVITY = 'ACTIVITY#';
/** Above every activity key ('$' follows '#'). */
export const ACTIVITY_END = 'ACTIVITY$';
/** Mail rows written before the activity log (30 days, until moved). */
export const LEGACY_MAIL = 'MAILLOG#';

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
  'upcoming',
  'settings',
  'pause',
  'status',
  'signin',
  'export',
  'address',
  'calendar',
  'connection',
  'account'
] as const;
export const familyOf = (kind: string): string => kind.split('.')[0]!;

type Row = Record<string, unknown>;

/** ISO time to the millisecond, as every activity key carries it. */
export const activityTime = (epochSeconds: number): string => new Date(Math.round(epochSeconds * 1000)).toISOString();

export function activityKey(at: string, kind: string, id: string): string {
  return `${ACTIVITY}${at}#${kind}#${id}`;
}

/** A row's id, which is also where a page of older rows starts. */
export const activityId = (sk: string): string => sk.slice(ACTIVITY.length);

/** A mail log row from before the activity log, as an activity row. */
export function legacyMail(row: Row): Row {
  const at = String(row.received_at);
  return { ...row, sk: activityKey(at, 'mail', String(row.message)), kind: 'mail', at };
}

const MAIL = ['message', 'received_at', 'via', 'day', 'version', 'subject', 'outcome', 'reason', 'sender', 'text'];
const READS = ['day', 'client', 'connection', 'calls', 'tools', 'errors', 'last_at'];

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
  return head;
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
