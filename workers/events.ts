/** SES notifications are private. Only event kinds/mail kinds/user IDs leave
 * this worker. SNS retries and overlapping subscriptions share a bounded,
 * account-owned transactional receipt. Ops publishing remains at-least-once.
 * A stop goes in the owner's activity log, with its reason and nothing of
 * the notification. */
import { createHash } from 'node:crypto';
import { normalEmail } from '../packages/backend/auth.ts';
import type { Store, Item } from '../packages/backend/store.ts';
import type { Log } from '../packages/backend/services.ts';
import { activityLog, recordActivity } from '../packages/backend/activity.ts';
import { addresses } from '../packages/mail/parse.ts';
export interface EventServices {
  store: Store;
  publish: (line: Item) => Promise<void>;
  clock?: () => number;
  log?: Log;
}
const record = (value: unknown): Item =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {};
const list = (value: unknown): Item[] => (Array.isArray(value) ? value.map(record) : []);
export function recipients(msg: Item): ['bounce' | 'complaint' | null, string[]] {
  const kind = msg.eventType ?? msg.notificationType;
  if (kind === 'Bounce') {
    const bounce = record(msg.bounce);
    if (bounce.bounceType !== 'Permanent') return [null, []];
    return ['bounce', list(bounce.bouncedRecipients).map((r) => String(r.emailAddress ?? ''))];
  }
  if (kind === 'Complaint')
    return ['complaint', list(record(msg.complaint).complainedRecipients).map((r) => String(r.emailAddress ?? ''))];
  return [null, []];
}
export function mailKind(msg: Item): string {
  return list(record(msg.mail).headers).some((h) => String(h.name ?? '').toLowerCase() === 'list-unsubscribe')
    ? 'daily'
    : 'account';
}
// These SES enumerations cannot echo an address, subject or arbitrary provider
// text. Unknown new service categories are scrubbed rather than copied.
const value = (raw: unknown, allowed: string[]): string | null =>
  typeof raw === 'string' && allowed.includes(raw) ? raw : null;
export function notice(msg: Item, users: (string | null)[]): Item | null {
  const raw = msg.eventType ?? msg.notificationType,
    kind =
      value(raw, [
        'Bounce',
        'Complaint',
        'Delivery',
        'Send',
        'Reject',
        'Rendering Failure',
        'RenderingFailure',
        'DeliveryDelay',
        'Subscription'
      ]) ?? 'unknown';
  if (kind === 'DeliveryDelay') return null;
  const line: Item = { source: 'yvn-release-notes', event: kind, mail: mailKind(msg) };
  if (kind === 'Bounce') {
    const b = record(msg.bounce);
    line.bounce_type = value(b.bounceType, ['Undetermined', 'Permanent', 'Transient']);
    line.bounce_subtype = value(b.bounceSubType, [
      'Undetermined',
      'General',
      'NoEmail',
      'Suppressed',
      'OnAccountSuppressionList',
      'MailboxFull',
      'MessageTooLarge',
      'ContentRejected',
      'AttachmentRejected'
    ]);
  }
  if (kind === 'Complaint')
    line.feedback = value(record(msg.complaint).complaintFeedbackType, [
      'abuse',
      'auth-failure',
      'fraud',
      'not-spam',
      'other',
      'virus'
    ]);
  if (kind === 'Reject') line.reason = value(record(msg.reject).reason, ['Bad content']);
  if (users.length) line.users = users;
  return line;
}
export async function handler(
  event: { Records?: { Sns?: { Message?: string; MessageId?: string } }[] },
  _context: unknown,
  services: EventServices
): Promise<void> {
  const log = (fields: Item) =>
      services.log?.(
        Object.fromEntries(
          Object.entries(fields).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
        ) as Record<string, string | number | boolean>
      ),
    now = Math.floor((services.clock ?? (() => Date.now() / 1000))()),
    at = new Date(now * 1000).toISOString().replace('.000Z', 'Z');
  for (const record of event.Records ?? []) {
    let msg: Item;
    try {
      const parsed: unknown = JSON.parse(record.Sns?.Message ?? '');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Invalid event');
      msg = parsed as Item;
    } catch {
      log({ event: 'mail-event', outcome: 'unreadable' });
      continue;
    }
    const [reason, rawAddresses] = recipients(msg),
      users: (string | null)[] = [];
    for (const raw of rawAddresses) {
      const parsed = await addresses([raw]),
        email = parsed.length === 1 ? normalEmail(parsed[0]) : null,
        user = email ? await services.store.userForEmail(email) : null;
      users.push(user);
      if (!user) {
        log({ event: 'mail-event', reason, outcome: 'no-account' });
        continue;
      }
      const snsId = record.Sns?.MessageId;
      // Real SNS records always name their message; refusing an absent ID avoids
      // silently falling back to an unsafe stop/tally pair.
      if (!snsId) throw new TypeError('SNS MessageId required for account event');
      const hash = createHash('sha256').update(snsId).digest('hex'),
        outcome = await services.store.applyMailEvent(user, hash, reason!, at, now);
      log({ event: 'mail-event', reason, outcome: outcome === 'applied' ? 'stopped' : outcome, user });
      if (outcome === 'applied')
        await recordActivity(
          services.store,
          user,
          now,
          [{ kind: 'status.stopped', id: hash.slice(0, 16), fields: { via: 'email', reason } }],
          services.log && activityLog(now, (fields) => services.log!(fields as Parameters<Log>[0]))
        );
    }
    const line = notice(msg, users);
    if (!line) {
      log({ event: 'mail-event', kind: 'DeliveryDelay', outcome: 'logged' });
      continue;
    }
    await services.publish(line);
  }
}
