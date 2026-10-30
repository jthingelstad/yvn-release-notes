/** Header-only proof precedes MIME. Reply tokens name the original day and
 * expire for writing after 72 hours; standing tokens name the subscriber's
 * received local day. Raw objects are tagged note/ignored, never rewritten.
 * Files use stable keys before the conditional note write, so retries converge.
 * Every message that reaches a subscriber goes in their activity log (filed,
 * not filed and why, or failed), with its words only once the sender is proven;
 * a few reasons, and a final failure, email the subscriber a notice. A note
 * filed for the first time adds a row for each badge it earned, as soon as it
 * is stored. A message given up on after a timeout or crash comes back through
 * the inbound failed queue (gaveUp) for its failed row and notice. */
import type { Store, Subscriber, Item } from '../packages/backend/store.ts';
import * as media from '../packages/backend/media.ts';
import type { Objects, Mail, Log } from '../packages/backend/services.ts';
import { collect, type TitleFetcher } from '../packages/backend/links.ts';
import { found as tags } from '../packages/domain/tags.ts';
import { MAX_NOTE, noteWords } from '../packages/domain/notes.ts';
import { localDay, addDays } from '../packages/domain/dates.ts';
import { computeVersion } from '../packages/domain/version.ts';
import { codePointSlice, codePointLength, pythonTrim } from '../packages/domain/unicode.ts';
import { activityKey, activityTime } from '../packages/domain/activity.ts';
import { activityLog, badgeEvents, recordActivity } from '../packages/backend/activity.ts';
import { unlockedBy } from '../packages/backend/badges.ts';
import {
  parseHeaders,
  parseMessage,
  addresses,
  noteText,
  attachments,
  anchors,
  MAX_RAW_BYTES,
  type MailHeaders,
  leaves
} from '../packages/mail/parse.ts';
import { lateMessage, messageId, noticeMessage, type NoticeReason } from '../packages/mail/compose.ts';
export const PARSER_VERSION = 3,
  REPLY_WINDOW = 72 * 3600,
  LATE_NOTICES_A_DAY = 3,
  NOTICES_A_DAY = 3,
  // The first try and InboundAliasInvokeConfig's two retries; after the last
  // the event goes to the failed queue.
  ATTEMPTS = 3;
const NOTICED = new Set<string>(['from-mismatch', 'unauthenticated', 'unparseable']);
/** What file() learned before it returned or threw, for the activity log. */
export interface Seen {
  sub?: Subscriber;
  standing?: boolean;
  day?: string;
  version?: string;
  sender?: string;
  text?: string;
}
export interface SesMail {
  messageId: string;
  timestamp: string;
  commonHeaders?: { from?: string[]; subject?: string };
}
export interface SesReceipt {
  recipients?: string[];
  spamVerdict?: { status?: string };
  virusVerdict?: { status?: string };
  dmarcVerdict?: { status?: string };
  dkimVerdict?: { status?: string };
}
export interface InboundServices {
  store: Store;
  objects: Objects;
  mail: Pick<Mail, 'send'>;
  fromAddress: string;
  inboundDomain: string;
  titleFetch?: TitleFetcher;
  log?: Log;
  /** Hands a given-up message on to the failed queue, as it came. */
  forward?: (body: string) => Promise<void>;
}
export function automatic(head: MailHeaders): boolean {
  return (
    pythonTrim(head.get('Auto-Submitted') || 'no').toLowerCase() !== 'no' ||
    Boolean(head.get('X-Autoreply') || head.get('X-Autorespond')) ||
    ['auto_reply', 'bulk', 'junk'].includes(pythonTrim(head.get('Precedence') || '').toLowerCase())
  );
}
export function tokenFrom(recipient: string, domain: string): [string, boolean] | null {
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    m = new RegExp(`^(n-)?([a-z2-7]{24})@${escaped}$`).exec(pythonTrim(recipient).toLowerCase());
  return m ? [m[2]!, !m[1]] : null;
}
export function deadline(token: Item): number {
  return token.sent_at != null
    ? Number(token.sent_at) + REPLY_WINDOW
    : Date.parse(`${addDays(String(token.date), 5)}T00:00:00Z`) / 1000;
}
export function received(mail: SesMail): number {
  const n = Date.parse(mail.timestamp) / 1000;
  if (!Number.isFinite(n)) throw new RangeError('Invalid received time');
  return n;
}
export function aligned(domain: string, fromDomain: string): boolean {
  domain = domain.toLowerCase().replace(/\.+$/, '');
  fromDomain = fromDomain.toLowerCase().replace(/\.+$/, '');
  return (
    domain.includes('.') &&
    fromDomain.includes('.') &&
    (domain === fromDomain || domain.endsWith('.' + fromDomain) || fromDomain.endsWith('.' + domain))
  );
}
export function results(header: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [],
    word = '',
    quoted = false,
    escaped = false,
    depth = 0;
  const end = () => {
    if (word) {
      words.push(word);
      word = '';
    }
  };
  for (const ch of header) {
    if (quoted) {
      word += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (depth) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    } else if (ch === '"') {
      quoted = true;
      word += ch;
    } else if (ch === '(') {
      end();
      depth = 1;
    } else if (ch === ';') {
      end();
      out.push(words);
      words = [];
    } else if (/\s/u.test(ch)) end();
    else word += ch;
  }
  end();
  out.push(words);
  return out;
}
export function dkimDomains(header: string): string[] {
  const out: string[] = [];
  for (const words of results(header)) {
    if (words[0]?.toLowerCase() !== 'dkim=pass') continue;
    const props: Record<string, string> = {};
    for (const word of words.slice(1)) {
      const i = word.indexOf('=');
      if (i >= 0) props[word.slice(0, i).toLowerCase()] ??= word.slice(i + 1);
    }
    const domain =
      props['header.d'] ??
      (props['header.i']?.includes('@') ? props['header.i'].slice(props['header.i'].lastIndexOf('@') + 1) : '');
    if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.?$/.test(domain)) out.push(domain);
  }
  return out;
}
export function authenticated(receipt: SesReceipt, head: MailHeaders, from: string): boolean {
  if (receipt.dmarcVerdict?.status === 'PASS') return true;
  if (receipt.dmarcVerdict?.status !== 'GRAY' || receipt.dkimVerdict?.status !== 'PASS') return false;
  const header = head.all('Authentication-Results')[0];
  if (!header || !pythonTrim(header).toLowerCase().startsWith('amazonses.com')) return false;
  return dkimDomains(header).some((d) => aligned(d, from.slice(from.lastIndexOf('@') + 1)));
}
export function soleFrom(head: MailHeaders): string {
  return head.all('From').length === 1 && head.from.length === 1 && !head.from[0]!.group
    ? (head.from[0]!.address ?? '').toLowerCase()
    : '';
}
export async function lateNotice(
  s: InboundServices,
  sub: Subscriber,
  token: string,
  tok: Item,
  head: MailHeaders,
  now: number
): Promise<void> {
  const log = (fields: Item) =>
      s.log?.(
        Object.fromEntries(
          Object.entries(fields).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
        ) as Record<string, string | number | boolean>
      ),
    done = (outcome: string, extra: Item = {}) => log({ event: 'late-notice', user: sub.user_id, outcome, ...extra });
  if (sub.status !== 'active') {
    done('skipped', { reason: 'stopped' });
    return;
  }
  try {
    const at = new Date(now * 1000).toISOString().replace('.000Z', 'Z'),
      reserved = await s.store.reserveLateNotice(sub.user_id, token, at, Math.floor(now), LATE_NOTICES_A_DAY);
    if (reserved !== 'reserved') {
      done('skipped', { reason: reserved });
      return;
    }
    const raw = await lateMessage({
      to: sub.email,
      fromAddr: s.fromAddress,
      version: String(tok.version),
      day: String(tok.date),
      inReplyTo: messageId(head.get('Message-ID'))
    });
    await s.mail.send(raw, sub.email);
  } catch (e) {
    done('failed', { error: errorName(e) });
    return;
  }
  done('sent', { date: tok.date });
}
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
async function words(raw: Buffer): Promise<string> {
  try {
    return codePointSlice(noteText(await parseMessage(raw)), 0, MAX_NOTE);
  } catch {
    return '';
  }
}
/** The subscriber a message's address names, from SES's event alone, with
 * what its activity row says of it (`seen`); why it is ignored when the
 * address names no one. */
async function addressee(mail: SesMail, receipt: SesReceipt, s: InboundServices, seen: Seen, spam: boolean) {
  const pair = (receipt.recipients ?? []).map((r) => tokenFrom(r, s.inboundDomain)).find(Boolean);
  if (!pair) return { reason: spam ? 'spam-or-virus' : 'no-token' };
  const [token, standing] = pair;
  const tok = standing ? await s.store.getInbox(token, true) : await s.store.getToken(token);
  if (!tok) return { reason: spam ? 'spam-or-virus' : 'unknown-token' };
  const sub = await s.store.getSubscriber(String(tok.user_id), standing);
  if (!sub) return { reason: spam ? 'spam-or-virus' : 'unknown-user' };
  const froms = await addresses(mail.commonHeaders?.from ?? []),
    from = froms.length === 1 ? froms[0] : '';
  Object.assign(seen, {
    sub,
    standing,
    day: standing ? localDay(received(mail), sub.tz) : String(tok.date),
    ...(from === sub.email.toLowerCase() ? {} : { sender: codePointSlice(froms.join(', ') || '(no sender)', 0, 300) })
  });
  seen.version = standing ? String(computeVersion(sub.birthday, seen.day!)) : String(tok.version);
  return { token, standing, tok, sub, from };
}
export async function file(
  mail: SesMail,
  receipt: SesReceipt,
  s: InboundServices,
  seen: Seen = {}
): Promise<[string, Item]> {
  const spam =
    receipt.spamVerdict?.status === 'FAIL' ||
    ['FAIL', 'PROCESSING_FAILED'].includes(receipt.virusVerdict?.status ?? '');
  const to = await addressee(mail, receipt, s, seen, spam);
  if ('reason' in to) return ['ignored', to];
  const { token, standing, tok, sub, from } = to;
  const ignored = (reason: string, extra: Item = {}): [string, Item] => [
    'ignored',
    { reason, user: sub.user_id, ...extra }
  ];
  if (spam) return ignored('spam-or-virus');
  if (standing && sub.inbox !== token) return ignored('replaced');
  if (standing && sub.status !== 'active') return ignored('stopped');
  if (from !== sub.email.toLowerCase()) return ignored('from-mismatch');
  const raw = (await s.objects.get(`raw/${mail.messageId}`, { maxBytes: MAX_RAW_BYTES })).body;
  let head: MailHeaders;
  try {
    head = await parseHeaders(raw);
  } catch (e) {
    return ignored('unparseable', { error: errorName(e) });
  }
  if (soleFrom(head) !== from) {
    seen.sender = codePointSlice(head.all('From').join(', ') || '(no sender)', 0, 300);
    return ignored('from-mismatch');
  }
  if (!authenticated(receipt, head, from)) return ignored('unauthenticated');
  if (automatic(head)) return ignored('auto-reply');
  if (!standing && received(mail) > deadline(tok)) {
    await lateNotice(s, sub, token, tok, head, received(mail));
    seen.text = await words(raw);
    return ignored('expired');
  }
  let text: string,
    files: ReturnType<typeof attachments>,
    named: Record<string, string>,
    photos: ReturnType<typeof media.found>;
  try {
    const msg = await parseMessage(raw);
    text = seen.text = codePointSlice(noteWords(noteText(msg)), 0, MAX_NOTE);
    files = attachments(msg);
    named = text ? anchors(msg) : {};
    const refused: number[] = [];
    photos = media.found(
      leaves(msg)
        .filter((p) => p.disposition === 'attachment' || !p.type.startsWith('text/'))
        .map((p) => ({ type: p.type, filename: p.filename, data: p.content })),
      refused
    );
    for (const n of refused) if (files[n]) files[n]!.refused = true;
  } catch (e) {
    return ignored('unparseable', { error: errorName(e) });
  }
  if (!text && !files.length) return ignored('empty');
  const day = seen.day!,
    version = seen.version!,
    found = text ? await collect(text, { named, fetch: s.titleFetch }) : [],
    kept = await media.storeFiles(
      {
        ...s.objects,
        put: (key, body, options) => s.objects.put(key, body, { ...options, tags: { outcome: 'pending' } })
      },
      sub.user_id,
      day,
      mail.messageId,
      photos
    ),
    tagged = tags(text),
    note: Item = {
      version,
      text,
      source: 'email',
      attachments: files,
      written_at: mail.timestamp,
      tz: sub.tz,
      ...(standing ? {} : { subject: codePointSlice(mail.commonHeaders?.subject ?? '', 0, 300) }),
      raw_key: `raw/${mail.messageId}`,
      parser_version: PARSER_VERSION,
      ...(found.length ? { links: found } : {}),
      ...(tagged.length ? { tags: tagged } : {}),
      ...(kept.length ? { media: kept } : {})
    };
  const stored = await s.store.putInboundNote(sub.user_id, day, mail.messageId, note, standing ? token : null);
  if (stored === 'refused') {
    const existing = await s.store.note(sub.user_id, day, mail.messageId),
      retained = new Set(existing ? media.keys(existing) : []);
    try {
      for (const m of kept) {
        if (retained.has(m.key)) await s.objects.tag(m.key, { outcome: 'note' });
        else await s.objects.remove(m.key);
      }
    } catch {
      throw new Error('Inbound staged-media cleanup failed');
    }
    return ignored('account-changed');
  }
  // Before its files are tagged: a tag that fails retries as a duplicate,
  // which records none.
  if (stored === 'stored')
    await earned(s, sub, { pk: `USER#${sub.user_id}`, sk: `NOTE#${day}#${mail.messageId}`, ...note }, received(mail));
  // A retry may meet an owner-edited/deleted note. Keep only media still named
  // by the existing note; no duplicate retry can attach or retain new files.
  const existing = stored === 'duplicate' ? await s.store.note(sub.user_id, day, mail.messageId) : null,
    retained = existing ? new Set(media.keys(existing)) : null;
  for (const m of kept) {
    if (stored === 'duplicate' && !retained?.has(m.key)) await s.objects.remove(m.key);
    else await s.objects.tag(m.key, { outcome: 'note' });
  }
  return [
    'note',
    {
      user: sub.user_id,
      date: day,
      chars: codePointLength(text),
      attachments: files.length,
      links: found.length,
      media: kept.length,
      duplicate: stored === 'duplicate',
      ...(standing ? { via: 'address' } : {})
    }
  ];
}
/** The badges a newly filed note earned, in the activity log at the time the
 * mail came in (none with "Show badges" off). Not marked seen, so the next
 * email tells of them. A failure here never fails or retries the filing. */
async function earned(s: InboundServices, sub: Subscriber, note: Item, at: number): Promise<void> {
  const [, day, ...id] = String(note.sk).split('#');
  let found: Awaited<ReturnType<typeof unlockedBy>>;
  try {
    const profile = sub.badges ? await s.store.profile(sub.user_id, true) : null;
    if (!profile || profile.badges === false) return;
    found = await unlockedBy(s.store, sub.user_id, profile, localDay(at, sub.tz), note);
  } catch (e) {
    s.log?.({ event: 'badges-error', user: sub.user_id, date: day!, error: errorName(e) });
    return;
  }
  await recordActivity(
    s.store,
    sub.user_id,
    at,
    badgeEvents(found, 'email', day!, id.join('#')),
    s.log && activityLog(at, (fields) => s.log!(fields as Parameters<Log>[0]))
  );
}
/** The email's activity row, kept for the life of the account. */
function logRow(mail: SesMail, seen: Seen): [string, Item] {
  const at = activityTime(received(mail));
  return [
    activityKey(at, 'mail', mail.messageId),
    {
      kind: 'mail',
      at,
      message: mail.messageId,
      received_at: at,
      via: seen.standing ? 'address' : 'reply',
      day: seen.day,
      version: seen.version,
      subject: codePointSlice(mail.commonHeaders?.subject ?? '', 0, 300),
      ...(seen.sender ? { sender: seen.sender } : {})
    }
  ];
}
/** At most one per message and NOTICES_A_DAY a day, to the subscriber's own
 * address; a stopped subscriber gets none. Never a reason to retry. */
async function notice(s: InboundServices, mail: SesMail, seen: Seen, sk: string, reason: NoticeReason) {
  const sub = seen.sub!,
    done = (outcome: string, extra: Record<string, string> = {}) =>
      s.log?.({ event: 'mail-notice', user: sub.user_id, reason, outcome, ...extra });
  if (sub.status !== 'active') return done('skipped', { why: 'stopped' });
  try {
    const now = Math.floor(received(mail)),
      reserved = await s.store.reserveMailNotice(
        sub.user_id,
        sk,
        new Date(now * 1000).toISOString(),
        now,
        NOTICES_A_DAY
      );
    if (reserved !== 'reserved') return done('skipped', { why: reserved });
    const raw = await noticeMessage({
      to: sub.email,
      fromAddr: s.fromAddress,
      reason,
      received: mail.timestamp,
      tz: sub.tz,
      kept: Boolean(seen.text)
    });
    await s.mail.send(raw, sub.email);
  } catch (e) {
    return done('failed', { error: errorName(e) });
  }
  done('sent');
}
/** A failure leaves a failed row (counting attempts) for the owner; the last
 * attempt also sends the notice. Best effort: the error itself is rethrown.
 * Given up on (`tries`, after a timeout or crash), the row takes the tries
 * Lambda made unless it has counted more, and keeps any words it has; a row
 * already filed or not filed stays as it is. There a failure to log throws, so
 * the inbound failed queue tries again before handing the record on. */
async function failure(s: InboundServices, mail: SesMail, seen: Seen, tries?: number): Promise<void> {
  if (!seen.sub) return;
  try {
    const [sk, row] = logRow(mail, seen),
      before = tries ? await s.store.mailEntry(seen.sub.user_id, sk) : null;
    if (before && before.outcome !== 'failed') return;
    if (typeof before?.text === 'string') seen.text = before.text;
    const kept = await s.store.recordMail(
      seen.sub.user_id,
      sk,
      {
        ...row,
        outcome: 'failed',
        reason: 'failed',
        ...(seen.text ? { text: seen.text } : {}),
        ...(tries ? { attempts: Math.max(tries, Number(before?.attempts ?? 0)) } : {})
      },
      { failed: !tries }
    );
    if (kept && (tries || Number((await s.store.mailEntry(seen.sub.user_id, sk))?.attempts ?? 0) >= ATTEMPTS))
      await notice(s, mail, seen, sk, 'failed');
  } catch (e) {
    s.log?.({ event: 'mail-log', user: seen.sub.user_id, outcome: 'failed', error: errorName(e) });
    if (tries) throw e;
  }
}
/** A message inbound gave up on, as Lambda's failure record names it
 * (InboundAliasInvokeConfig, through InboundFailedQueue): a timeout or crash
 * that left no row gets its failed row and the owner's notice now, as a
 * failure the code caught does, and once logged it goes on to the failed queue
 * for the operator. A throw leaves it on the inbound failed queue, whose last
 * try hands it on unread. */
export async function gaveUp(body: string, s: InboundServices): Promise<void> {
  if (!s.forward) throw new Error('No failed queue to hand on to');
  let record: { requestContext?: { approximateInvokeCount?: unknown }; requestPayload?: unknown } = {};
  try {
    record = JSON.parse(body) as typeof record;
  } catch {
    // Not a failure record: handed on as it came.
  }
  const tries = Math.max(1, Number(record.requestContext?.approximateInvokeCount) || ATTEMPTS),
    payload = (record.requestPayload ?? {}) as Parameters<typeof handler>[0];
  for (const r of payload.Records ?? [])
    if ('ses' in r && r.ses?.mail?.messageId) {
      const seen: Seen = {};
      await addressee(r.ses.mail, r.ses.receipt, s, seen, false);
      await failure(s, r.ses.mail, seen, tries);
    }
  await s.forward(body);
}
export async function process(ses: { mail: SesMail; receipt: SesReceipt }, services: InboundServices): Promise<string> {
  const seen: Seen = {};
  let filed: string, detail: Item;
  try {
    [filed, detail] = await file(ses.mail, ses.receipt, services, seen);
  } catch (e) {
    await failure(services, ses.mail, seen);
    throw e;
  }
  const key = `raw/${ses.mail.messageId}`,
    prior = await services.objects.tags(key),
    outcome = prior.outcome === 'note' ? 'note' : filed;
  await services.objects.tag(key, { outcome });
  services.log?.(
    Object.fromEntries(
      Object.entries({ event: 'inbound', message: ses.mail.messageId, outcome: filed, ...detail }).filter(([, v]) =>
        ['string', 'number', 'boolean'].includes(typeof v)
      )
    ) as Record<string, string | number | boolean>
  );
  if (seen.sub) {
    // A throw here retries the message, which files as a duplicate and logs again.
    const [sk, row] = logRow(ses.mail, seen),
      note = filed === 'note',
      reason = note ? '' : String(detail.reason);
    const kept = await services.store.recordMail(
      seen.sub.user_id,
      sk,
      note
        ? { ...row, outcome: 'filed', day: detail.date }
        : { ...row, outcome: 'not-filed', reason, ...(seen.text ? { text: seen.text } : {}) },
      { drop: note ? ['reason', 'text'] : seen.text ? [] : ['text'] }
    );
    if (kept && NOTICED.has(reason)) await notice(services, ses.mail, seen, sk, reason as NoticeReason);
  }
  return filed;
}
/** SES's event, or a batch from the inbound failed queue (`body`). */
export async function handler(
  event: { Records?: ({ ses: { mail: SesMail; receipt: SesReceipt } } | { body: string })[] },
  _context: unknown,
  services: InboundServices
): Promise<void> {
  for (const record of event.Records ?? [])
    if ('body' in record) await gaveUp(record.body, services);
    else await process(record.ses, services);
}
