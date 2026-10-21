/** One DynamoDB table, preserving the Python archive's keys, fields and conditions.
 * All SDK commands use native document values, including Set for import ledgers.
 * Reads never rely on TTL removal. Callers enforce credential expirations.
 * USER#/PROFILE, NOTE#, DAY#, PAUSE#, WEATHER#, PLACE#, EXPORT, SESSION#,
 * Nested OAuth ownership rows use OAUTHUSER ROW#; content-free MCP metadata
 * uses MCPMETA USE#/LOG#/WRITERATE#.
 * IMPORT#, CAPTURE#, MAILEVENT#, PROCESS#, PROCESSLOCK#; TOKEN#, INBOX#, EMAIL#, LOGIN#, LOGINFOR#, RATE#, LOCK#,
 * TALLY#, OAUTHCLIENT#, OAUTHPENDING#, OAUTHCODE#, OAUTHACCESS#, OAUTHREFRESH#,
 * OAUTHFAMILY#, OAUTHUSER#, MCPMETA# retain their original layouts.
 * PRODUCT#UPDATES / UPDATE#<id> holds operator drafts/history; DATE#<YYYY-MM-DD>
 * holds the sole scheduled text snapshot for that subscriber-local email day.
 * Both are outside USER# archives; revision CAS and date-slot ownership are atomic.
 * USER#<owner> / UPCOMING#<id> holds private personal dates and an optional
 * normalized tag (null when absent), separate from notes; legacy rows omit tag.
 * PROFILE.upcoming_count and entry revision change atomically (200 retained
 * entries per owner); web transactions also prove the live account/session.
 * CALENDAR#<token> / CALENDAR names the owner of a private iCalendar feed link
 * (PROFILE.calendar points back), as INBOX# does the standing address: made and
 * replaced on the Upcoming page, removed with the profile, never logged.
 * TURNSTILE#<sha256 of token> / VERDICT keeps Cloudflare's answer for one
 * sign-in token (result, codes, email_hash, uses, verified_at) for five
 * minutes and three uses (`turnstile.ts`); no address, only its hash.
 * USER#<owner> / BADGES holds `seen`, a string set of the badges (`id` or
 * `id:tier`) already celebrated, so the email names each once
 * (docs/BADGES.md). Only ever ADDed to, with the account proof; deleted
 * with the account and never exported.
 * USER#<owner> / MAILLOG#<received ISO>#<SES message id> is the mail log
 * (docs/WEB-APP.md): what became of each email that reached the owner's
 * address (outcome, reason, sender, subject, and the text only for a sender
 * already proven), kept 30 days (expires_at), shown only to its owner,
 * deleted with the account and never exported. notified_at marks the one
 * problem notice; RATE#mailnotice:<owner>#<UTC day> caps them at three a day.
 */
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import type {
  QueryCommandInput,
  ScanCommandInput,
  UpdateCommandInput,
  TransactWriteCommandInput
} from '@aws-sdk/lib-dynamodb';
import { Subscriber } from './store-types.ts';
import type { ProductUpdate } from '../domain/product-updates.ts';
import { upcomingEntry, UPCOMING_MAX, type UpcomingEntry } from '../domain/upcoming.ts';
import type { UpcomingChange } from './upcoming.ts';
import type { DocumentSender, Item, Key, MailCounter, Purpose, SessionInput } from './store-types.ts';
export { Subscriber } from './store-types.ts';
export type { Item, Key, DocumentSender, MailCounter } from './store-types.ts';
const newest = { signin: 'LOGIN', delete: 'DELETE' };
const purposeCondition = {
  signin: '(attribute_not_exists(#purpose) OR #purpose = :purpose)',
  delete: '#purpose = :purpose'
};
const key = (user: string, sk: string): Key => ({ pk: `USER#${user}`, sk });
import { writtenAt as written } from '../domain/notes.ts';
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const conditionFailed = (e: unknown) => e instanceof Error && e.name === 'ConditionalCheckFailedException';
function reasons(e: unknown): { Code?: string }[] {
  return (e as { CancellationReasons?: { Code?: string }[] })?.CancellationReasons ?? [];
}
function conflict(e: unknown) {
  return (
    (e as { name?: string })?.name === 'TransactionCanceledException' &&
    reasons(e).length > 0 &&
    reasons(e).every((r) => ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code ?? ''))
  );
}
function media(item: Item | null): Item[] {
  return (item?.media as Item[] | undefined) ?? [];
}
function productNews(row: Item): ProductUpdate {
  const update = { ...row };
  delete update.pk;
  delete update.sk;
  return update as unknown as ProductUpdate;
}

export class Store {
  readonly client: DocumentSender;
  readonly tableName: string;
  constructor(client: DocumentSender, tableName: string) {
    this.client = client;
    this.tableName = tableName;
  }
  private async get(Key: Key, options: Item = {}): Promise<Item | null> {
    return (await this.client.send(new GetCommand({ TableName: this.tableName, Key, ...options }))).Item ?? null;
  }
  private async put(Item: Item, options: Item = {}) {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item, ...options }));
  }
  private async del(Key: Key, options: Item = {}) {
    return this.client.send(new DeleteCommand({ TableName: this.tableName, Key, ...options }));
  }
  private async update(Key: Key, input: Omit<UpdateCommandInput, 'TableName' | 'Key'>) {
    return this.client.send(new UpdateCommand({ TableName: this.tableName, Key, ...input }));
  }
  private async conditional(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (e) {
      if (conditionFailed(e)) return false;
      throw e;
    }
  }
  private async rows(
    input: Omit<QueryCommandInput, 'TableName'> | Omit<ScanCommandInput, 'TableName'>,
    scan = false
  ): Promise<Item[]> {
    const items: Item[] = [];
    let cursor: Key | undefined;
    do {
      const args = { TableName: this.tableName, ...input, ...(cursor ? { ExclusiveStartKey: cursor } : {}) };
      const result = await this.client.send(scan ? new ScanCommand(args) : new QueryCommand(args));
      items.push(...(result.Items ?? []));
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  private async transact(TransactItems: TransactWriteCommandInput['TransactItems']): Promise<boolean> {
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems }));
      return true;
    } catch (e) {
      if (conflict(e)) return false;
      throw e;
    }
  }
  private putOperation(Item: Item, options: Item = {}) {
    return { Put: { TableName: this.tableName, Item, ...options } };
  }
  async activeSubscribers() {
    return (
      await this.rows(
        {
          FilterExpression: 'sk = :p AND #s = :a',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':p': 'PROFILE', ':a': 'active' }
        },
        true
      )
    ).map(Subscriber.fromItem);
  }
  async upcomingEntries(user: string): Promise<UpcomingEntry[]> {
    return (
      await this.rows({
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        ExpressionAttributeValues: { ':p': `USER#${user}`, ':s': 'UPCOMING#' },
        ConsistentRead: true
      })
    ).map(upcomingEntry);
  }
  async upcoming(user: string, id: string): Promise<UpcomingEntry | null> {
    const row = await this.get(key(user, 'UPCOMING#' + id), { ConsistentRead: true });
    return row ? upcomingEntry(row) : null;
  }
  async saveUpcoming(user: string, next: UpcomingEntry | null, previous: UpcomingEntry | null): Promise<boolean> {
    const id = next?.id ?? previous!.id,
      entryKey = key(user, 'UPCOMING#' + id);
    const guard = previous
      ? {
          ConditionExpression: '#revision = :revision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':revision': previous.revision }
        }
      : { ConditionExpression: 'attribute_not_exists(pk)' };
    const ops: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      next
        ? this.putOperation({ ...entryKey, ...next }, guard)
        : { Delete: { TableName: this.tableName, Key: entryKey, ...guard } }
    ];
    if (!previous || !next)
      ops.push({
        Update: {
          TableName: this.tableName,
          Key: key(user, 'PROFILE'),
          UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :change',
          ConditionExpression:
            'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND ' +
            (next ? '(attribute_not_exists(#count) OR #count < :max)' : '#count > :zero'),
          ExpressionAttributeNames: { '#count': 'upcoming_count' },
          ExpressionAttributeValues: { ':zero': 0, ':change': next ? 1 : -1, ...(next ? { ':max': UPCOMING_MAX } : {}) }
        }
      });
    else ops.push(this.profileProof(user));
    return this.provedTransaction(ops);
  }
  /** Many entries at once, each with the single-entry guards, the count moved
   * by the net change (never past 200) in the same transaction. Up to 90 per
   * transaction; a longer batch commits in order and reports how far it got.
   * `extra` (an agent's proof, receipt and audit) must fit one transaction. */
  async upcomingBatch(
    user: string,
    changes: readonly UpcomingChange[],
    extra: NonNullable<TransactWriteCommandInput['TransactItems']> = []
  ): Promise<{ ok: boolean; applied: number }> {
    const size = 90;
    if (extra.length && changes.length > size) throw new RangeError('Batch too large for one transaction');
    let applied = 0;
    for (let start = 0; start < changes.length; start += size) {
      const chunk = changes.slice(start, start + size),
        net = chunk.filter((c) => !c.previous).length - chunk.filter((c) => !c.next).length;
      const ops: NonNullable<TransactWriteCommandInput['TransactItems']> = chunk.map(({ next, previous }) => {
        const entryKey = key(user, 'UPCOMING#' + (next?.id ?? previous!.id)),
          guard = previous
            ? {
                ConditionExpression: '#revision = :revision',
                ExpressionAttributeNames: { '#revision': 'revision' },
                ExpressionAttributeValues: { ':revision': previous.revision }
              }
            : { ConditionExpression: 'attribute_not_exists(pk)' };
        return next
          ? this.putOperation({ ...entryKey, ...next }, guard)
          : { Delete: { TableName: this.tableName, Key: entryKey, ...guard } };
      });
      ops.push(
        net
          ? {
              Update: {
                TableName: this.tableName,
                Key: key(user, 'PROFILE'),
                UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :change',
                ConditionExpression:
                  'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND ' +
                  (net > 0 ? '(attribute_not_exists(#count) OR #count <= :room)' : '#count >= :need'),
                ExpressionAttributeNames: { '#count': 'upcoming_count' },
                ExpressionAttributeValues: {
                  ':zero': 0,
                  ':change': net,
                  ...(net > 0 ? { ':room': UPCOMING_MAX - net } : { ':need': -net })
                }
              }
            }
          : this.profileProof(user),
        ...extra
      );
      if (!(await this.provedTransaction(ops))) return { ok: false, applied };
      applied += chunk.length;
    }
    return { ok: true, applied };
  }
  async productUpdates(): Promise<ProductUpdate[]> {
    const rows = await this.rows({
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': 'PRODUCT#UPDATES', ':s': 'UPDATE#' },
      ConsistentRead: true
    });
    return rows.map(productNews);
  }
  async productUpdate(id: string): Promise<ProductUpdate | null> {
    const row = await this.get({ pk: 'PRODUCT#UPDATES', sk: 'UPDATE#' + id }, { ConsistentRead: true });
    if (!row) return null;
    return productNews(row);
  }
  async scheduledProductUpdate(day: string): Promise<ProductUpdate | null> {
    const row = await this.get({ pk: 'PRODUCT#UPDATES', sk: 'DATE#' + day }, { ConsistentRead: true });
    if (!row) return null;
    return productNews(row);
  }
  async saveProductUpdate(user: string, email: string, next: ProductUpdate | null, previous: ProductUpdate | null) {
    const id = next?.id ?? previous!.id,
      updateKey = { pk: 'PRODUCT#UPDATES', sk: 'UPDATE#' + id };
    const guard = previous
      ? {
          ConditionExpression: '#revision = :revision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':revision': previous.revision }
        }
      : { ConditionExpression: 'attribute_not_exists(pk)' };
    const ops: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: key(user, 'PROFILE'),
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND email = :admin',
          ExpressionAttributeValues: { ':admin': email }
        }
      },
      next
        ? this.putOperation({ ...updateKey, ...next }, guard)
        : { Delete: { TableName: this.tableName, Key: updateKey, ...guard } }
    ];
    if (previous?.status === 'scheduled' && previous.date)
      ops.push({
        Delete: {
          TableName: this.tableName,
          Key: { pk: 'PRODUCT#UPDATES', sk: 'DATE#' + previous.date },
          ConditionExpression: 'id = :id',
          ExpressionAttributeValues: { ':id': id }
        }
      });
    if (next?.status === 'scheduled' && next.date)
      ops.push(
        this.putOperation(
          { pk: 'PRODUCT#UPDATES', sk: 'DATE#' + next.date, ...next },
          { ConditionExpression: 'attribute_not_exists(pk)' }
        )
      );
    return this.provedTransaction(ops);
  }
  /** Administrator-only metadata scan. IAM separately limits Scan to these
   * attributes and SPECIFIC_ATTRIBUTES; no archive reader is used here. */
  async subscriberOverviewItems() {
    return this.rows(
      {
        Select: 'SPECIFIC_ATTRIBUTES',
        FilterExpression: 'begins_with(pk, :u) AND (sk = :p OR begins_with(sk, :n) OR begins_with(sk, :i))',
        ProjectionExpression:
          'pk, sk, email, #st, stopped_reason, created_at, tz, send_time, last_sent_date, pause_from, pause_through, written_at, received_at, #src, updated_at, mcp_deleting',
        ExpressionAttributeNames: { '#st': 'status', '#src': 'source' },
        ExpressionAttributeValues: { ':u': 'USER#', ':p': 'PROFILE', ':n': 'NOTE#', ':i': 'IMPORT#' }
      },
      true
    );
  }
  async censusItems() {
    return this.rows(
      {
        FilterExpression: 'begins_with(pk, :u) AND (sk = :p OR begins_with(sk, :d) OR begins_with(sk, :n))',
        ProjectionExpression: 'pk, sk, #st, tz, send_time, last_sent_date, pause_from, pause_through, #src, #m[0].#k',
        ExpressionAttributeNames: { '#st': 'status', '#src': 'source', '#m': 'media', '#k': 'kind' },
        ExpressionAttributeValues: { ':u': 'USER#', ':p': 'PROFILE', ':d': 'DAY#', ':n': 'NOTE#' }
      },
      true
    );
  }
  async userIds() {
    return (
      await this.rows(
        { FilterExpression: 'sk = :p', ProjectionExpression: 'pk', ExpressionAttributeValues: { ':p': 'PROFILE' } },
        true
      )
    )
      .filter((i) => String(i.pk).startsWith('USER#'))
      .map((i) => String(i.pk).slice(5))
      .sort();
  }
  async getSubscriber(user: string, consistent = false) {
    const item = await this.get(key(user, 'PROFILE'), { ConsistentRead: consistent });
    return item ? Subscriber.fromItem(item) : null;
  }
  async claimDay(user: string, day: string) {
    return this.conditional(() =>
      this.update(key(user, 'PROFILE'), {
        UpdateExpression: 'SET last_sent_date = :d',
        ConditionExpression:
          'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND (attribute_not_exists(#status) OR #status = :active) AND (attribute_not_exists(last_sent_date) OR last_sent_date < :d)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':d': day, ':active': 'active' }
      })
    );
  }
  async releaseDay(user: string, day: string, previous: string | null, token?: string) {
    const input = {
      UpdateExpression: previous ? 'SET last_sent_date = :p' : 'REMOVE last_sent_date',
      ConditionExpression: 'last_sent_date = :d',
      ExpressionAttributeValues: previous ? { ':p': previous, ':d': day } : { ':d': day }
    };
    if (!token) {
      await this.update(key(user, 'PROFILE'), input);
      return;
    }
    if (
      !(await this.provedTransaction([
        { Update: { TableName: this.tableName, Key: key(user, 'PROFILE'), ...input } },
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: key(user, `DAY#${day}`),
            ConditionExpression: 'attribute_not_exists(pk) OR #token = :token',
            ExpressionAttributeNames: { '#token': 'token' },
            ExpressionAttributeValues: { ':token': token }
          }
        }
      ]))
    )
      throw Object.assign(new Error('Send reservation no longer owned'), { name: 'ConditionalCheckFailedException' });
  }
  async putDay(user: string, day: string, version: string, token: string, sentAt: string) {
    const sent = Math.floor(Date.parse(sentAt) / 1000);
    if (!Number.isFinite(sent)) throw new Error('Invalid send time');
    return this.provedTransaction([
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: key(user, 'PROFILE'),
          ConditionExpression:
            'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND (attribute_not_exists(#status) OR #status = :active)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':active': 'active' }
        }
      },
      this.putOperation(
        { pk: `TOKEN#${token}`, sk: 'TOKEN', user_id: user, date: day, version, sent_at: sent },
        { ConditionExpression: 'attribute_not_exists(pk)' }
      ),
      this.putOperation(
        { ...key(user, `DAY#${day}`), version, token, sent_at: sentAt },
        { ConditionExpression: 'attribute_not_exists(pk)' }
      )
    ]);
  }
  async dropDay(user: string, day: string, token: string) {
    await this.del({ pk: `TOKEN#${token}`, sk: 'TOKEN' });
    await this.conditional(() =>
      this.del(key(user, `DAY#${day}`), {
        ConditionExpression: '#t = :t',
        ExpressionAttributeNames: { '#t': 'token' },
        ExpressionAttributeValues: { ':t': token }
      })
    );
  }
  async setDayMessageId(user: string, day: string, message: string, token: string) {
    return this.provedTransaction([
      this.profileProof(user),
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, `DAY#${day}`),
          UpdateExpression: 'SET ses_message_id = :m',
          ConditionExpression: 'attribute_exists(pk) AND #token = :token',
          ExpressionAttributeNames: { '#token': 'token' },
          ExpressionAttributeValues: { ':m': message, ':token': token }
        }
      }
    ]);
  }
  async getToken(token: string) {
    return this.get({ pk: `TOKEN#${token}`, sk: 'TOKEN' });
  }
  async claimLateNotice(token: string, at: string) {
    return this.conditional(() =>
      this.update(
        { pk: `TOKEN#${token}`, sk: 'TOKEN' },
        {
          UpdateExpression: 'SET late_notice_at = :t',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(late_notice_at)',
          ExpressionAttributeValues: { ':t': at }
        }
      )
    );
  }
  async getInbox(token: string, consistent = false) {
    return this.get({ pk: `INBOX#${token}`, sk: 'INBOX' }, { ConsistentRead: consistent });
  }
  async setInbox(user: string, token: string, now: string, old: string | null = null) {
    return this.setHandle('INBOX', 'inbox', user, token, now, old);
  }
  async getCalendar(token: string) {
    return this.get({ pk: `CALENDAR#${token}`, sk: 'CALENDAR' });
  }
  async setCalendar(user: string, token: string, now: string, old: string | null = null) {
    return this.setHandle('CALENDAR', 'calendar', user, token, now, old);
  }
  /** Ends the feed link: its row goes with the profile's pointer, which must still name it. */
  async dropCalendar(user: string, token: string): Promise<boolean> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: this.tableName, Key: { pk: `CALENDAR#${token}`, sk: 'CALENDAR' } } },
            {
              Update: {
                TableName: this.tableName,
                Key: key(user, 'PROFILE'),
                UpdateExpression: 'REMOVE calendar',
                ConditionExpression: 'attribute_exists(pk) AND calendar = :t',
                ExpressionAttributeValues: { ':t': token }
              }
            }
          ]
        })
      );
      return true;
    } catch (e) {
      if (reasons(e).some((r) => r.Code === 'ConditionalCheckFailed')) return false;
      throw e;
    }
  }
  /** A private token row naming its owner, with the profile pointing back. Replacing
   * one removes the old row in the same transaction and fails closed on a race. */
  private async setHandle(prefix: string, field: string, user: string, token: string, now: string, old: string | null) {
    const operations: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      this.putOperation(
        { pk: `${prefix}#${token}`, sk: prefix, user_id: user, created_at: now },
        { ConditionExpression: 'attribute_not_exists(pk)' }
      ),
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, 'PROFILE'),
          UpdateExpression: `SET ${field} = :t`,
          ConditionExpression:
            'attribute_exists(pk) AND ' + (old ? `${field} = :old` : `attribute_not_exists(${field})`),
          ExpressionAttributeValues: { ':t': token, ...(old ? { ':old': old } : {}) }
        }
      }
    ];
    if (old) operations.push({ Delete: { TableName: this.tableName, Key: { pk: `${prefix}#${old}`, sk: prefix } } });
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: operations }));
      return true;
    } catch (e) {
      if (reasons(e).some((r) => r.Code === 'ConditionalCheckFailed')) return false;
      throw e;
    }
  }
  private async keys(user: string, prefix: string) {
    return new Set(
      (
        await this.rows({
          KeyConditionExpression: 'pk = :u AND begins_with(sk, :n)',
          ExpressionAttributeValues: { ':u': `USER#${user}`, ':n': prefix },
          ProjectionExpression: 'sk'
        })
      ).map((i) => String(i.sk))
    );
  }
  private async dates(user: string, prefix: string) {
    return new Set([...(await this.keys(user, prefix))].map((sk) => sk.split('#')[1]!));
  }
  async noteIds(user: string) {
    return new Set([...(await this.keys(user, 'NOTE#'))].map((sk) => sk.split('#').slice(2).join('#')));
  }
  async noteDays(user: string) {
    return this.dates(user, 'NOTE#');
  }
  async sentDays(user: string) {
    return this.dates(user, 'DAY#');
  }
  async noteIndex(user: string): Promise<[string, number][]> {
    return (
      await this.rows({
        KeyConditionExpression: 'pk = :u AND begins_with(sk, :n)',
        ExpressionAttributeValues: { ':u': `USER#${user}`, ':n': 'NOTE#' },
        ProjectionExpression: 'sk, #m',
        ExpressionAttributeNames: { '#m': 'media' }
      })
    ).map((i) => [String(i.sk).split('#')[1]!, media(i).filter((m) => m.kind === 'image').length]);
  }
  async notesBetween(user: string, first: string, last: string, query: Omit<QueryCommandInput, 'TableName'> = {}) {
    const items = await this.rows({
      ...query,
      KeyConditionExpression: 'pk = :u AND sk BETWEEN :a AND :b',
      ExpressionAttributeValues: {
        ':u': `USER#${user}`,
        ':a': `NOTE#${first}#`,
        ':b': `NOTE#${last}$`,
        ...query.ExpressionAttributeValues
      }
    });
    return items.sort(
      (a, b) =>
        compare(String(a.sk).split('#')[1]!, String(b.sk).split('#')[1]!) ||
        compare(written(a), written(b)) ||
        compare(String(a.sk), String(b.sk))
    );
  }
  async dayNotes(user: string, day: string) {
    return (
      await this.rows({
        KeyConditionExpression: 'pk = :u AND begins_with(sk, :n)',
        ExpressionAttributeValues: { ':u': `USER#${user}`, ':n': `NOTE#${day}#` }
      })
    ).sort((a, b) => compare(written(a), written(b)) || compare(String(a.sk), String(b.sk)));
  }
  async allNotes(user: string, consistent = false) {
    return this.notesBetween(user, '0000-00-00', '9999-99-99', consistent ? { ConsistentRead: true } : {});
  }
  async noteTags(user: string) {
    return this.notesBetween(user, '0000-00-00', '9999-99-99', {
      ProjectionExpression: 'sk, #g',
      ExpressionAttributeNames: { '#g': 'tags' }
    });
  }
  async taggedNotes(user: string, tag: string) {
    return this.notesBetween(user, '0000-00-00', '9999-99-99', {
      FilterExpression: 'contains(#g, :g)',
      ExpressionAttributeNames: { '#g': 'tags' },
      ExpressionAttributeValues: { ':g': tag }
    });
  }
  async putNote(user: string, day: string, id: string, note: Item) {
    return this.conditional(() =>
      this.put({ ...key(user, `NOTE#${day}#${id}`), ...note }, { ConditionExpression: 'attribute_not_exists(pk)' })
    );
  }
  /** Recheck the account and standing address at the write, after slow
   * MIME/link/media work. Existing email tokens still accept stopped accounts
   * within their reply window; standing addresses require active/current. */
  async putInboundNote(
    user: string,
    day: string,
    id: string,
    note: Item,
    standingToken: string | null = null
  ): Promise<'stored' | 'duplicate' | 'refused'> {
    for (let attempt = 0; attempt < 5; attempt++)
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: this.tableName,
                  Key: key(user, 'PROFILE'),
                  ConditionExpression:
                    'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)' +
                    (standingToken ? ' AND inbox = :token AND #status = :active' : ''),
                  ...(standingToken
                    ? {
                        ExpressionAttributeNames: { '#status': 'status' },
                        ExpressionAttributeValues: { ':token': standingToken, ':active': 'active' }
                      }
                    : {})
                }
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: { ...key(user, `NOTE#${day}#${id}`), ...note },
                  ConditionExpression: 'attribute_not_exists(pk)'
                }
              }
            ]
          })
        );
        return 'stored';
      } catch (e) {
        if ((e as { name?: string })?.name !== 'TransactionCanceledException') throw e;
        const failure = reasons(e);
        if (failure[0]?.Code === 'ConditionalCheckFailed') return 'refused';
        if (failure[1]?.Code === 'ConditionalCheckFailed') return 'duplicate';
        if (failure.some((r) => r.Code === 'TransactionConflict') && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    throw new Error('Inbound proof transaction retries exhausted');
  }
  async updateNote(
    user: string,
    day: string,
    id: string,
    text: string,
    at: string,
    links: Item[] | null = null,
    tags: string[] | null = null
  ) {
    const sets = ['#t = :t', 'updated_at = :at'];
    const removes: string[] = [];
    const values: Item = { ':t': text, ':at': at };
    for (const [name, ref, value] of [
      ['links', ':l', links],
      ['tags', ':g', tags]
    ] as const) {
      if (value?.length) {
        sets.push(`${name} = ${ref}`);
        values[ref] = value;
      } else removes.push(name);
    }
    try {
      return (
        (
          await this.update(key(user, `NOTE#${day}#${id}`), {
            UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ' REMOVE ' + removes.join(', ') : ''}`,
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeNames: { '#t': 'text' },
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW'
          })
        ).Attributes ?? null
      );
    } catch (e) {
      if (conditionFailed(e)) return null;
      throw e;
    }
  }
  async addMedia(user: string, day: string, id: string, entries: Item[], had: number, at: string) {
    try {
      return (
        (
          await this.update(key(user, `NOTE#${day}#${id}`), {
            UpdateExpression: 'SET media = list_append(if_not_exists(media, :none), :m), updated_at = :at',
            ConditionExpression:
              'attribute_exists(pk) AND ' + (had ? 'size(media) = :had' : 'attribute_not_exists(media)'),
            ExpressionAttributeValues: { ':m': entries, ':none': [], ':at': at, ...(had ? { ':had': had } : {}) },
            ReturnValues: 'ALL_NEW'
          })
        ).Attributes ?? null
      );
    } catch (e) {
      if (conditionFailed(e)) return null;
      throw e;
    }
  }
  async note(user: string, day: string, id: string, consistent = false) {
    return this.get(key(user, `NOTE#${day}#${id}`), { ConsistentRead: consistent });
  }
  /** USER-owned leases suppress concurrent stream/backfill work. Consent, the
   * immutable source and optional UTC-day quota are proved together. */
  async claimProcessing(
    kind: 'transcribe' | 'describe',
    user: string,
    day: string,
    id: string,
    n: number,
    source: string,
    type: string,
    owner: string,
    now: number
  ): Promise<boolean> {
    const note = await this.note(user, day, id, true);
    const at = media(note).findIndex((m) => Number(m.n) === n);
    if (at < 0) return false;
    const field = kind === 'transcribe' ? 'transcript' : 'description';
    const period = Math.floor(now / 86400);
    return this.provedTransaction([
      this.consentProof(user, kind),
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: key(user, `NOTE#${day}#${id}`),
          ConditionExpression: `attribute_exists(pk) AND media[${at}].n = :n AND media[${at}].#k = :k AND media[${at}].#type = :type AND attribute_not_exists(media[${at}].#f)`,
          ExpressionAttributeNames: { '#k': 'key', '#type': 'type', '#f': field },
          ExpressionAttributeValues: { ':n': n, ':k': source, ':type': type }
        }
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            ...key(user, `PROCESS#${kind}#${day}#${id}#${n}`),
            owner,
            source,
            type,
            expires_at: now + (kind === 'describe' ? 960 : 30 * 86400)
          },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
          ExpressionAttributeValues: { ':now': now }
        }
      },
      ...(kind === 'transcribe'
        ? [
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: `RATE#transcribe:${user}#${period}`, sk: 'RATE' },
                UpdateExpression: 'ADD n :one SET expires_at = :exp',
                ConditionExpression: 'attribute_not_exists(n) OR n < :max',
                ExpressionAttributeValues: { ':one': 1, ':exp': (period + 2) * 86400, ':max': 30 }
              }
            }
          ]
        : [])
    ]);
  }
  private consentProof(
    user: string,
    kind: 'transcribe' | 'describe'
  ): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: key(user, 'PROFILE'),
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND #opt = :yes',
        ExpressionAttributeNames: { '#opt': kind },
        ExpressionAttributeValues: { ':yes': true }
      }
    };
  }
  async takeProcessingLock(user: string, holder: string, now: number, seconds: number): Promise<boolean> {
    return this.provedTransaction([
      this.consentProof(user, 'describe'),
      {
        Put: {
          TableName: this.tableName,
          Item: { ...key(user, 'PROCESSLOCK#describe'), owner: holder, expires_at: now + seconds },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now OR #owner = :o',
          ExpressionAttributeNames: { '#owner': 'owner' },
          ExpressionAttributeValues: { ':now': now, ':o': holder }
        }
      }
    ]);
  }
  async releaseProcessingLock(user: string, holder: string): Promise<boolean> {
    return this.conditional(() =>
      this.del(key(user, 'PROCESSLOCK#describe'), {
        ConditionExpression: '#owner = :o',
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: { ':o': holder }
      })
    );
  }
  /** Whether a describe_all chain holds this account's describe lock now. */
  async describeChainLive(user: string, now: number): Promise<boolean> {
    const lock = await this.get(key(user, 'PROCESSLOCK#describe'), { ConsistentRead: true });
    return Boolean(lock && Number(lock.expires_at) > now);
  }
  async processing(user: string, kind: 'transcribe' | 'describe', day: string, id: string, n: number) {
    return this.get(key(user, `PROCESS#${kind}#${day}#${id}#${n}`), { ConsistentRead: true });
  }
  async releaseProcessing(
    user: string,
    kind: 'transcribe' | 'describe',
    day: string,
    id: string,
    n: number,
    owner: string
  ) {
    return this.conditional(() =>
      this.del(key(user, `PROCESS#${kind}#${day}#${id}#${n}`), {
        ConditionExpression: '#owner = :o',
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: { ':o': owner }
      })
    );
  }
  async finishProcessing(
    kind: 'transcribe' | 'describe',
    user: string,
    day: string,
    id: string,
    n: number,
    source: string,
    type: string,
    text: string,
    owner: string | null
  ): Promise<boolean> {
    const note = await this.note(user, day, id, true);
    const at = media(note).findIndex((m) => Number(m.n) === n);
    if (at < 0) return false;
    const field = kind === 'transcribe' ? 'transcript' : 'description';
    return this.provedTransaction([
      this.consentProof(user, kind),
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, `NOTE#${day}#${id}`),
          UpdateExpression: `SET media[${at}].#f = :text`,
          ConditionExpression: `attribute_exists(pk) AND media[${at}].n = :n AND media[${at}].#k = :k AND media[${at}].#type = :type AND attribute_not_exists(media[${at}].#f)`,
          ExpressionAttributeNames: { '#k': 'key', '#type': 'type', '#f': field },
          ExpressionAttributeValues: { ':n': n, ':k': source, ':type': type, ':text': text }
        }
      },
      ...(owner
        ? [
            {
              Delete: {
                TableName: this.tableName,
                Key: key(user, `PROCESS#${kind}#${day}#${id}#${n}`),
                ConditionExpression: '#owner = :o AND #src = :k',
                ExpressionAttributeNames: { '#owner': 'owner', '#src': 'source' },
                ExpressionAttributeValues: { ':o': owner, ':k': source }
              }
            }
          ]
        : [])
    ]);
  }
  async setMediaFieldGuarded(
    user: string,
    day: string,
    id: string,
    n: number,
    field: string,
    value: unknown,
    source: string
  ): Promise<boolean> {
    const note = await this.note(user, day, id, true);
    const at = media(note).findIndex((m) => Number(m.n) === n && m.key === source);
    if (at < 0) return false;
    return this.provedTransaction([
      this.profileProof(user),
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, `NOTE#${day}#${id}`),
          UpdateExpression: `SET media[${at}].#f = :v`,
          ConditionExpression: `attribute_exists(pk) AND media[${at}].n = :n AND media[${at}].#k = :k AND attribute_not_exists(media[${at}].#f)`,
          ExpressionAttributeNames: { '#k': 'key', '#f': field },
          ExpressionAttributeValues: { ':n': n, ':k': source, ':v': value }
        }
      }
    ]);
  }
  async setNotePlaceGuarded(
    user: string,
    day: string,
    id: string,
    place: Item,
    source?: { n: number; key: string; lat: number; lon: number }
  ) {
    let sourceCondition = '';
    if (source) {
      const at = media(await this.note(user, day, id, true)).findIndex(
        (m) => Number(m.n) === source.n && m.key === source.key
      );
      if (at < 0) return false;
      sourceCondition = ` AND media[${at}].n = :n AND media[${at}].#k = :k AND media[${at}].#p.lat = :lat AND media[${at}].#p.lon = :lon`;
    }
    return this.provedTransaction([
      this.profileProof(user),
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, `NOTE#${day}#${id}`),
          UpdateExpression: 'SET #p = :p',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#p)' + sourceCondition,
          ExpressionAttributeNames: { '#p': 'place', ...(source ? { '#k': 'key' } : {}) },
          ExpressionAttributeValues: {
            ':p': place,
            ...(source ? { ':n': source.n, ':k': source.key, ':lat': source.lat, ':lon': source.lon } : {})
          }
        }
      }
    ]);
  }
  /** Scope ordinary worker metadata/weather writes to an existing account.
   * Reads are unchanged. Conditional refusals cannot recreate deleted USER rows. */
  forLiveAccount(user: string): Store {
    const sender: DocumentSender = {
      send: async (command) => {
        const input = Object.fromEntries(
          Object.entries(command.input).filter(
            ([name]) => !['ReturnValues', 'ReturnConsumedCapacity', 'ReturnItemCollectionMetrics'].includes(name)
          )
        );
        const operation =
          command instanceof PutCommand
            ? { Put: input }
            : command instanceof UpdateCommand
              ? { Update: input }
              : command instanceof DeleteCommand
                ? { Delete: input }
                : null;
        if (!operation) return this.client.send(command);
        const accepted = await this.provedTransaction([
          this.profileProof(user),
          operation as NonNullable<TransactWriteCommandInput['TransactItems']>[number]
        ]);
        if (!accepted)
          throw Object.assign(new Error('Account metadata write refused'), { name: 'ProcessingAccountGone' });
        return {};
      }
    };
    return new Store(sender, this.tableName);
  }
  async setMediaText(user: string, day: string, id: string, n: number, field: string, text: string) {
    return this.setMediaField(user, day, id, n, field, text);
  }
  async setMediaField(user: string, day: string, id: string, n: number, field: string, value: unknown) {
    const at = media(await this.note(user, day, id)).findIndex((m) => Number(m.n) === n);
    if (at < 0) return false;
    return this.conditional(() =>
      this.update(key(user, `NOTE#${day}#${id}`), {
        UpdateExpression: `SET media[${at}].#f = :t`,
        ConditionExpression: `attribute_exists(pk) AND media[${at}].n = :n`,
        ExpressionAttributeNames: { '#f': field },
        ExpressionAttributeValues: { ':t': value, ':n': n }
      })
    );
  }
  async deleteNote(user: string, day: string, id: string) {
    return (await this.del(key(user, `NOTE#${day}#${id}`), { ReturnValues: 'ALL_OLD' })).Attributes ?? null;
  }
  async userForEmail(email: string) {
    const item = await this.get({ pk: `EMAIL#${email}`, sk: 'EMAIL' });
    return item ? String(item.user_id) : null;
  }
  async profile(user: string, consistent = false) {
    return this.get(key(user, 'PROFILE'), consistent ? { ConsistentRead: true } : {});
  }
  /** Only once the standing address and feed link are the ones being removed with it. */
  async deleteProfile(user: string, inbox: string | null, calendar: string | null = null) {
    const values = { ...(inbox ? { ':t': inbox } : {}), ...(calendar ? { ':c': calendar } : {}) };
    return this.conditional(() =>
      this.del(key(user, 'PROFILE'), {
        ConditionExpression:
          (inbox ? 'inbox = :t' : 'attribute_not_exists(inbox)') +
          ' AND ' +
          (calendar ? 'calendar = :c' : 'attribute_not_exists(calendar)'),
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {})
      })
    );
  }
  async createSubscriber(user: string, email: string, profile: Item) {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            this.putOperation(
              { pk: `EMAIL#${email}`, sk: 'EMAIL', user_id: user },
              { ConditionExpression: 'attribute_not_exists(pk)' }
            ),
            this.putOperation(
              { ...key(user, 'PROFILE'), email, ...profile },
              { ConditionExpression: 'attribute_not_exists(pk)' }
            )
          ]
        })
      );
      return true;
    } catch (e) {
      if (reasons(e).some((r) => r.Code === 'ConditionalCheckFailed')) return false;
      throw e;
    }
  }
  async createSubscriberVerified(
    user: string,
    email: string,
    profile: Item,
    hash: string,
    now: number,
    expires: number
  ): Promise<boolean> {
    return this.provedTransaction([
      this.putOperation(
        { pk: `EMAIL#${email}`, sk: 'EMAIL', user_id: user },
        { ConditionExpression: 'attribute_not_exists(pk)' }
      ),
      this.putOperation(
        { ...key(user, 'PROFILE'), email, ...profile },
        { ConditionExpression: 'attribute_not_exists(pk)' }
      ),
      {
        Update: {
          TableName: this.tableName,
          Key: { pk: `SESSION#${hash}`, sk: 'SESSION' },
          UpdateExpression: 'SET user_id = :u, seen_at = :now, expires_at = :exp REMOVE email',
          ConditionExpression:
            'attribute_exists(pk) AND expires_at > :now AND attribute_not_exists(user_id) AND email = :e',
          ExpressionAttributeValues: { ':u': user, ':e': email, ':now': now, ':exp': expires }
        }
      },
      { Put: { TableName: this.tableName, Item: { ...key(user, `SESSION#${hash}`), expires_at: expires } } }
    ]);
  }
  async updateProfile(user: string, fields: Item, remove: string[] = []) {
    const entries = Object.entries(fields);
    const names = Object.fromEntries([
      ...entries.map(([k], i) => [`#f${i}`, k]),
      ...remove.map((k, i) => [`#r${i}`, k])
    ]);
    const values = Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v]));
    const expr =
      (entries.length ? 'SET ' + entries.map((_, i) => `#f${i} = :v${i}`).join(', ') : '') +
      (remove.length ? ' REMOVE ' + remove.map((_, i) => `#r${i}`).join(', ') : '');
    if (!expr.trim()) return;
    await this.update(key(user, 'PROFILE'), {
      UpdateExpression: expr.trim(),
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: names,
      ...(entries.length ? { ExpressionAttributeValues: values } : {})
    });
  }
  async stop(user: string, reason: string, at: string) {
    await this.updateProfile(user, { status: 'stopped', stopped_reason: reason, stopped_at: at });
  }
  /** SNS retry/alias overlap applies one stop and one monthly count. The
   * receipt contains no mail content and is deleted with the account. */
  async applyMailEvent(
    user: string,
    messageHash: string,
    reason: 'bounce' | 'complaint',
    at: string,
    now: number
  ): Promise<'applied' | 'duplicate' | 'gone'> {
    const receiptKey = key(user, `MAILEVENT#${messageHash}`);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: this.tableName,
                  Key: key(user, 'PROFILE'),
                  UpdateExpression: 'SET #s = :s, stopped_reason = :r, stopped_at = :at',
                  ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: { ':s': 'stopped', ':r': reason, ':at': at }
                }
              },
              {
                Update: {
                  TableName: this.tableName,
                  Key: { pk: `TALLY#${at.slice(0, 7)}`, sk: 'TALLY' },
                  UpdateExpression: 'ADD #n :one',
                  ExpressionAttributeNames: { '#n': reason + 's' },
                  ExpressionAttributeValues: { ':one': 1 }
                }
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: { ...receiptKey, expires_at: now + 30 * 86400 },
                  ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
                  ExpressionAttributeValues: { ':now': now }
                }
              }
            ]
          })
        );
        return 'applied';
      } catch (e) {
        if ((e as { name?: string })?.name !== 'TransactionCanceledException') throw e;
        const failure = reasons(e);
        if (failure[2]?.Code === 'ConditionalCheckFailed') return 'duplicate';
        if (failure[0]?.Code === 'ConditionalCheckFailed') return 'gone';
        if (failure.some((r) => r.Code === 'TransactionConflict') && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw new Error('Mail event transaction retries exhausted');
  }
  /** The three-notice UTC-day cap and per-token reservation commit together.
   * A stopped/deleting/missing account consumes no counter or reply token. */
  async reserveLateNotice(
    user: string,
    token: string,
    at: string,
    now: number,
    limit = 3
  ): Promise<'reserved' | 'limited' | 'already-sent' | 'stopped'> {
    const period = Math.floor(now / 86400);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: this.tableName,
                  Key: key(user, 'PROFILE'),
                  ConditionExpression: 'attribute_exists(pk) AND #s = :s AND attribute_not_exists(mcp_deleting)',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: { ':s': 'active' }
                }
              },
              {
                Update: {
                  TableName: this.tableName,
                  Key: { pk: `TOKEN#${token}`, sk: 'TOKEN' },
                  UpdateExpression: 'SET late_notice_at = :at',
                  ConditionExpression: 'attribute_exists(pk) AND user_id = :u AND attribute_not_exists(late_notice_at)',
                  ExpressionAttributeValues: { ':at': at, ':u': user }
                }
              },
              {
                Update: {
                  TableName: this.tableName,
                  Key: { pk: `RATE#latenotice:${user}#${period}`, sk: 'RATE' },
                  UpdateExpression: 'SET expires_at = :expiry ADD #n :one',
                  ConditionExpression: 'attribute_not_exists(#n) OR #n < :limit',
                  ExpressionAttributeNames: { '#n': 'n' },
                  ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':expiry': (period + 2) * 86400 }
                }
              }
            ]
          })
        );
        return 'reserved';
      } catch (e) {
        if ((e as { name?: string })?.name !== 'TransactionCanceledException') throw e;
        const failure = reasons(e);
        if (failure[0]?.Code === 'ConditionalCheckFailed') return 'stopped';
        if (failure[2]?.Code === 'ConditionalCheckFailed') return 'limited';
        if (failure[1]?.Code === 'ConditionalCheckFailed') return 'already-sent';
        if (failure.some((r) => r.Code === 'TransactionConflict') && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw new Error('Late notice transaction retries exhausted');
  }
  /** One mail log row, with the account proof (false once it is gone). SET
   * leaves notified_at in place, so a retry never notifies twice; `failed`
   * also ADDs one to attempts. */
  async recordMail(
    user: string,
    sk: string,
    fields: Item,
    o: { drop?: readonly string[]; failed?: boolean } = {}
  ): Promise<boolean> {
    if (!sk.startsWith('MAILLOG#')) throw new RangeError('Not a mail log row');
    const entries = Object.entries(fields),
      drop = o.drop ?? [];
    return this.provedTransaction([
      this.profileProof(user),
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, sk),
          UpdateExpression:
            'SET ' +
            entries.map((_, i) => `#f${i} = :v${i}`).join(', ') +
            (o.failed ? ' ADD attempts :one' : '') +
            (drop.length ? ' REMOVE ' + drop.map((_, i) => `#d${i}`).join(', ') : ''),
          ExpressionAttributeNames: {
            ...Object.fromEntries(entries.map(([k], i) => [`#f${i}`, k])),
            ...Object.fromEntries(drop.map((k, i) => [`#d${i}`, k]))
          },
          ExpressionAttributeValues: {
            ...Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
            ...(o.failed ? { ':one': 1 } : {})
          }
        }
      }
    ]);
  }
  async mailEntry(user: string, sk: string): Promise<Item | null> {
    return this.get(key(user, sk), { ConsistentRead: true });
  }
  /** The last 30 days of the mail log, newest first. */
  async mailLog(user: string, now: number): Promise<Item[]> {
    return (
      await this.rows({
        KeyConditionExpression: 'pk = :u AND begins_with(sk, :m)',
        ExpressionAttributeValues: { ':u': `USER#${user}`, ':m': 'MAILLOG#' },
        ScanIndexForward: false
      })
    ).filter((i) => Number(i.expires_at ?? 0) > now);
  }
  /** As reserveLateNotice: one notice per log row and three a UTC day,
   * committed together; a stopped/deleting/missing account consumes neither. */
  async reserveMailNotice(
    user: string,
    sk: string,
    at: string,
    now: number,
    limit = 3
  ): Promise<'reserved' | 'limited' | 'already-sent' | 'stopped'> {
    const period = Math.floor(now / 86400);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: this.tableName,
                  Key: key(user, 'PROFILE'),
                  ConditionExpression: 'attribute_exists(pk) AND #s = :s AND attribute_not_exists(mcp_deleting)',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: { ':s': 'active' }
                }
              },
              {
                Update: {
                  TableName: this.tableName,
                  Key: key(user, sk),
                  UpdateExpression: 'SET notified_at = :at',
                  ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(notified_at)',
                  ExpressionAttributeValues: { ':at': at }
                }
              },
              {
                Update: {
                  TableName: this.tableName,
                  Key: { pk: `RATE#mailnotice:${user}#${period}`, sk: 'RATE' },
                  UpdateExpression: 'SET expires_at = :expiry ADD #n :one',
                  ConditionExpression: 'attribute_not_exists(#n) OR #n < :limit',
                  ExpressionAttributeNames: { '#n': 'n' },
                  ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':expiry': (period + 2) * 86400 }
                }
              }
            ]
          })
        );
        return 'reserved';
      } catch (e) {
        if ((e as { name?: string })?.name !== 'TransactionCanceledException') throw e;
        const failure = reasons(e);
        if (failure[0]?.Code === 'ConditionalCheckFailed') return 'stopped';
        if (failure[1]?.Code === 'ConditionalCheckFailed') return 'already-sent';
        if (failure[2]?.Code === 'ConditionalCheckFailed') return 'limited';
        if (failure.some((r) => r.Code === 'TransactionConflict') && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw new Error('Mail notice transaction retries exhausted');
  }
  async pauses(user: string, consistent = false): Promise<[string, string][]> {
    return (
      await this.rows({
        KeyConditionExpression: 'pk = :u AND begins_with(sk, :n)',
        ExpressionAttributeValues: { ':u': `USER#${user}`, ':n': 'PAUSE#' },
        ...(consistent ? { ConsistentRead: true } : {})
      })
    ).map((i) => [String(i.sk).slice(6), String(i.through)]);
  }
  async putPause(user: string, start: string, through: string, at: string) {
    await this.put({ ...key(user, `PAUSE#${start}`), through, created_at: at });
    await this.updateProfile(user, { pause_from: start, pause_through: through });
  }
  async endPause(user: string, start: string, through: string | null) {
    if (through)
      await this.update(key(user, `PAUSE#${start}`), {
        UpdateExpression: 'SET through = :t',
        ExpressionAttributeValues: { ':t': through }
      });
    else await this.del(key(user, `PAUSE#${start}`));
    await this.update(key(user, 'PROFILE'), {
      UpdateExpression: 'REMOVE pause_from, pause_through',
      ConditionExpression: 'attribute_exists(pk)'
    });
  }
  async deleteKeys(keys: Key[]) {
    for (let i = 0; i < keys.length; i += 25) {
      let requests = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
      let retries = 0;
      while (requests.length) {
        const result = await this.client.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } }));
        requests = (result.UnprocessedItems?.[this.tableName] ?? []) as typeof requests;
        if (requests.length) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 25 * 2 ** Math.min(retries++, 6))));
        }
      }
    }
  }
  async importedIds(user: string): Promise<Set<string>> {
    const rows = await this.rows({
      KeyConditionExpression: 'pk = :u AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':u': `USER#${user}`, ':p': 'IMPORT#' },
      ProjectionExpression: 'ids',
      ConsistentRead: true
    });
    return new Set(rows.flatMap((row) => [...((row.ids ?? []) as Iterable<string>)]));
  }
  async imported(user: string, ledger: string) {
    const item = await this.get(key(user, ledger), { ProjectionExpression: 'ids' });
    return new Set(item?.ids as Iterable<string> | undefined);
  }
  /** The import ledger and note commit together, so an owner-deleted note
   * can never be revived by an interrupted/repeated import. */
  async putImportedNote(
    user: string,
    day: string,
    id: string,
    note: Item,
    ledger: string,
    originId: string,
    at: string
  ): Promise<boolean> {
    return this.provedTransaction([
      this.profileProof(user),
      this.putOperation(
        { ...key(user, `NOTE#${day}#${id}`), ...note },
        { ConditionExpression: 'attribute_not_exists(pk)' }
      ),
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, ledger),
          UpdateExpression: 'ADD ids :ids SET updated_at = :at',
          ConditionExpression: 'attribute_not_exists(ids) OR NOT contains(ids, :id)',
          ExpressionAttributeValues: { ':ids': new Set([originId]), ':id': originId, ':at': at }
        }
      }
    ]);
  }
  async addImported(user: string, ledger: string, ids: string[], at: string) {
    if (!ids.length) return;
    await this.update(key(user, ledger), {
      UpdateExpression: 'ADD ids :i SET updated_at = :t',
      ExpressionAttributeValues: { ':i': new Set(ids), ':t': at }
    });
  }
  async seenBadges(user: string): Promise<Set<string>> {
    const item = await this.get(key(user, 'BADGES'), { ProjectionExpression: 'seen', ConsistentRead: true });
    return new Set(item?.seen as Iterable<string> | undefined);
  }
  /** ADD, so a repeat is harmless; false once the account is gone. */
  async addSeenBadges(user: string, badges: readonly string[], at: string): Promise<boolean> {
    if (!badges.length) return true;
    return this.provedTransaction([
      this.profileProof(user),
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, 'BADGES'),
          UpdateExpression: 'ADD seen :s SET updated_at = :t',
          ExpressionAttributeValues: { ':s': new Set(badges), ':t': at }
        }
      }
    ]);
  }
  async putWeather(user: string, day: string, fields: Item) {
    return this.conditional(() =>
      this.put({ ...key(user, `WEATHER#${day}`), ...fields }, { ConditionExpression: 'attribute_not_exists(sk)' })
    );
  }
  async replaceWeather(user: string, day: string, fields: Item) {
    await this.put({ ...key(user, `WEATHER#${day}`), ...fields });
  }
  async renameWeather(user: string, day: string, kept: Item, names: Item) {
    const ks = Object.keys(names);
    return this.conditional(() =>
      this.update(key(user, `WEATHER#${day}`), {
        UpdateExpression: 'SET ' + ks.map((k) => `#${k} = :${k}`).join(', '),
        ConditionExpression: ['lat = :lat', 'lon = :lon', ...ks.map((k) => `#${k} = :was_${k}`)].join(' AND '),
        ExpressionAttributeNames: Object.fromEntries(ks.map((k) => [`#${k}`, k])),
        ExpressionAttributeValues: {
          ...Object.fromEntries(Object.entries(names).map(([k, v]) => [`:${k}`, v])),
          ...Object.fromEntries(ks.map((k) => [`:was_${k}`, kept[k] ?? ''])),
          ':lat': kept.lat ?? null,
          ':lon': kept.lon ?? null
        }
      })
    );
  }
  async dropWeather(user: string, day: string, kept: Item) {
    return this.conditional(() =>
      this.del(key(user, `WEATHER#${day}`), {
        ConditionExpression: 'lat = :lat AND lon = :lon',
        ExpressionAttributeValues: { ':lat': kept.lat ?? null, ':lon': kept.lon ?? null }
      })
    );
  }
  private async byDay(user: string, prefix: string, first: string, last: string, consistent = false) {
    return Object.fromEntries(
      (
        await this.rows({
          KeyConditionExpression: 'pk = :u AND sk BETWEEN :a AND :b',
          ExpressionAttributeValues: { ':u': `USER#${user}`, ':a': `${prefix}${first}`, ':b': `${prefix}${last}` },
          ...(consistent ? { ConsistentRead: true } : {})
        })
      ).map((i) => [String(i.sk).slice(prefix.length), i])
    );
  }
  async weatherBetween(user: string, first: string, last: string, consistent = false) {
    return this.byDay(user, 'WEATHER#', first, last, consistent);
  }
  async placesBetween(user: string, first: string, last: string) {
    return this.byDay(user, 'PLACE#', first, last);
  }
  async dayPlace(user: string, day: string, consistent = false) {
    return this.get(key(user, `PLACE#${day}`), consistent ? { ConsistentRead: true } : {});
  }
  async setDayPlace(user: string, day: string, place: Item) {
    await this.put({ ...key(user, `PLACE#${day}`), ...place });
  }
  async clearDayPlace(user: string, day: string) {
    await this.del(key(user, `PLACE#${day}`));
  }
  async setNotePlace(user: string, day: string, id: string, place: Item) {
    return this.conditional(() =>
      this.update(key(user, `NOTE#${day}#${id}`), {
        UpdateExpression: 'SET #p = :p',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#p)',
        ExpressionAttributeNames: { '#p': 'place' },
        ExpressionAttributeValues: { ':p': place }
      })
    );
  }
  async export(user: string) {
    return this.get(key(user, 'EXPORT'));
  }
  async startExport(user: string, id: string, now: number, expires: number) {
    await this.put({ ...key(user, 'EXPORT'), id, status: 'building', started_at: now, expires_at: expires });
  }
  async finishExportGuarded(user: string, id: string, fields: Item): Promise<boolean> {
    const entries = Object.entries(fields);
    return this.provedTransaction([
      this.profileProof(user),
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, 'EXPORT'),
          UpdateExpression: 'SET ' + entries.map((_, i) => `#f${i} = :v${i}`).join(', '),
          ConditionExpression: '#id = :id AND #s = :b',
          ExpressionAttributeNames: {
            '#id': 'id',
            '#s': 'status',
            ...Object.fromEntries(entries.map(([k], i) => [`#f${i}`, k]))
          },
          ExpressionAttributeValues: {
            ':id': id,
            ':b': 'building',
            ...Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v]))
          }
        }
      }
    ]);
  }
  async finishExport(user: string, id: string, fields: Item) {
    const entries = Object.entries(fields);
    return this.conditional(() =>
      this.update(key(user, 'EXPORT'), {
        UpdateExpression: 'SET ' + entries.map((_, i) => `#f${i} = :v${i}`).join(', '),
        ConditionExpression: '#id = :id AND #s = :b',
        ExpressionAttributeNames: {
          '#id': 'id',
          '#s': 'status',
          ...Object.fromEntries(entries.map(([k], i) => [`#f${i}`, k]))
        },
        ExpressionAttributeValues: {
          ':id': id,
          ':b': 'building',
          ...Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v]))
        }
      })
    );
  }
  async userItems(user: string) {
    return this.rows({ KeyConditionExpression: 'pk = :u', ExpressionAttributeValues: { ':u': `USER#${user}` } });
  }
  async putLogin(
    hash: string,
    email: string,
    emailHash: string,
    codeHash: string,
    now: number,
    ttl: number,
    purpose: Purpose = 'signin'
  ) {
    const expires = now + ttl;
    await this.put({
      pk: `LOGIN#${hash}`,
      sk: 'LOGIN',
      email,
      email_hash: emailHash,
      code_hash: codeHash,
      purpose,
      attempts: 0,
      created_at: now,
      expires_at: expires
    });
    await this.put({ pk: `LOGINFOR#${emailHash}`, sk: newest[purpose], token_hash: hash, expires_at: expires });
  }
  async newestLogin(hash: string, purpose: Purpose = 'signin') {
    const item = await this.get({ pk: `LOGINFOR#${hash}`, sk: newest[purpose] });
    return item ? String(item.token_hash) : null;
  }
  async loginKeys(hash: string): Promise<Key[]> {
    const keys: Key[] = [];
    for (const sk of Object.values(newest)) {
      const k = { pk: `LOGINFOR#${hash}`, sk };
      const item = await this.get(k);
      if (item) keys.push(k, { pk: `LOGIN#${item.token_hash}`, sk: 'LOGIN' });
    }
    return keys;
  }
  async spendAttempt(
    hash: string,
    now: number,
    max: number,
    purpose: Purpose = 'signin'
  ): Promise<Item | 'gone' | 'used' | 'attempts'> {
    try {
      return (
        await this.update(
          { pk: `LOGIN#${hash}`, sk: 'LOGIN' },
          {
            UpdateExpression: 'SET attempts = attempts + :one',
            ConditionExpression: `attribute_exists(pk) AND attribute_not_exists(used_at) AND expires_at > :now AND attempts < :max AND ${purposeCondition[purpose]}`,
            ExpressionAttributeNames: { '#purpose': 'purpose' },
            ExpressionAttributeValues: { ':one': 1, ':now': now, ':max': max, ':purpose': purpose },
            ReturnValues: 'ALL_NEW'
          }
        )
      ).Attributes!;
    } catch (e) {
      if (!conditionFailed(e)) throw e;
    }
    const item = await this.get({ pk: `LOGIN#${hash}`, sk: 'LOGIN' });
    if (!item || Number(item.expires_at ?? 0) <= now || (item.purpose ?? 'signin') !== purpose) return 'gone';
    return Object.hasOwn(item, 'used_at') ? 'used' : 'attempts';
  }
  async burnLogin(hash: string, now: number, purpose: Purpose = 'signin') {
    try {
      return (
        (
          await this.update(
            { pk: `LOGIN#${hash}`, sk: 'LOGIN' },
            {
              UpdateExpression: 'SET used_at = :now',
              ConditionExpression: `attribute_exists(pk) AND attribute_not_exists(used_at) AND expires_at > :now AND ${purposeCondition[purpose]}`,
              ExpressionAttributeNames: { '#purpose': 'purpose' },
              ExpressionAttributeValues: { ':now': now, ':purpose': purpose },
              ReturnValues: 'ALL_NEW'
            }
          )
        ).Attributes ?? null
      );
    } catch (e) {
      if (conditionFailed(e)) return null;
      throw e;
    }
  }
  async count(k: string, period: number, span = 3600) {
    const item = (
      await this.update(
        { pk: `RATE#${k}#${period}`, sk: 'RATE' },
        {
          UpdateExpression: 'ADD n :one SET expires_at = :exp',
          ExpressionAttributeValues: { ':one': 1, ':exp': (period + 2) * span },
          ReturnValues: 'UPDATED_NEW'
        }
      )
    ).Attributes;
    return Number(item?.n ?? 0);
  }
  async turnstileVerdict(tokenHash: string) {
    return this.get({ pk: `TURNSTILE#${tokenHash}`, sk: 'VERDICT' });
  }
  /** The first answer for a token wins; it counts as its first use. */
  async saveTurnstileVerdict(
    tokenHash: string,
    v: { result: 'pass' | 'fail'; email_hash: string; codes: string; now: number; ttl: number }
  ) {
    return this.conditional(() =>
      this.put(
        {
          pk: `TURNSTILE#${tokenHash}`,
          sk: 'VERDICT',
          result: v.result,
          email_hash: v.email_hash,
          codes: v.codes,
          uses: 1,
          verified_at: v.now,
          expires_at: v.now + v.ttl
        },
        { ConditionExpression: 'attribute_not_exists(pk)' }
      )
    );
  }
  /** One more use of a kept verdict, for the same address, while under the cap. */
  async useTurnstileVerdict(tokenHash: string, emailHash: string, maxUses: number) {
    return this.conditional(() =>
      this.update(
        { pk: `TURNSTILE#${tokenHash}`, sk: 'VERDICT' },
        {
          UpdateExpression: 'ADD uses :one',
          ConditionExpression: 'email_hash = :email AND uses < :max',
          ExpressionAttributeValues: { ':one': 1, ':email': emailHash, ':max': maxUses }
        }
      )
    );
  }
  /** Atomic eligibility+reservation, narrow counters first; no counter is consumed on denial. */
  async reserveMail(counters: MailCounter[]): Promise<{ ok: boolean; limited?: string }> {
    if (!counters.length) return { ok: true };
    if (new Set(counters.map((c) => `${c.key}#${c.period}`)).size !== counters.length)
      throw new Error('Duplicate mail counter');
    const operations = counters.map((c) => ({
      Update: {
        TableName: this.tableName,
        Key: { pk: `RATE#${c.key}#${c.period}`, sk: 'RATE' },
        UpdateExpression: 'ADD n :one SET expires_at = :exp',
        ConditionExpression: 'attribute_not_exists(pk) OR n < :limit',
        ExpressionAttributeValues: { ':one': 1, ':exp': (c.period + 2) * (c.span ?? 3600), ':limit': c.limit }
      }
    }));
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: operations }));
        return { ok: true };
      } catch (e) {
        const rs = reasons(e);
        if (
          (e as Error).name !== 'TransactionCanceledException' ||
          !rs.length ||
          rs.some((r) => !['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code ?? ''))
        )
          throw e;
        const at = rs.findIndex((r) => r.Code === 'ConditionalCheckFailed');
        if (at >= 0) return { ok: false, limited: counters[at]!.key };
      }
    }
    throw Object.assign(new Error('Mail reservation conflicted'), { name: 'TransactionConflictException' });
  }
  async countUpload(user: string, day: number, size: number, maxFiles: number, maxBytes: number) {
    return this.conditional(() =>
      this.update(
        { pk: `RATE#upload:${user}#${day}`, sk: 'RATE' },
        {
          UpdateExpression: 'ADD n :one, #b :size SET expires_at = :exp',
          ConditionExpression: 'attribute_not_exists(pk) OR (n < :files AND #b <= :room)',
          ExpressionAttributeNames: { '#b': 'bytes' },
          ExpressionAttributeValues: {
            ':one': 1,
            ':size': size,
            ':exp': (day + 2) * 86400,
            ':files': maxFiles,
            ':room': maxBytes - size
          }
        }
      )
    );
  }
  async takeLock(name: string, holder: string, now: number, forSeconds: number) {
    return this.conditional(() =>
      this.update(
        { pk: `LOCK#${name}`, sk: 'LOCK' },
        {
          UpdateExpression: 'SET #h = :h, expires_at = :exp',
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now OR #h = :h',
          ExpressionAttributeNames: { '#h': 'holder' },
          ExpressionAttributeValues: { ':h': holder, ':exp': now + forSeconds, ':now': now }
        }
      )
    );
  }
  async releaseLock(name: string, holder: string, now: number) {
    await this.conditional(() =>
      this.update(
        { pk: `LOCK#${name}`, sk: 'LOCK' },
        {
          UpdateExpression: 'SET expires_at = :now',
          ConditionExpression: '#h = :h',
          ExpressionAttributeNames: { '#h': 'holder' },
          ExpressionAttributeValues: { ':h': holder, ':now': now }
        }
      )
    );
  }
  async peek(k: string, period: number) {
    return Number((await this.get({ pk: `RATE#${k}#${period}`, sk: 'RATE' }))?.n ?? 0);
  }
  async tally(month: string, name: string) {
    await this.update(
      { pk: `TALLY#${month}`, sk: 'TALLY' },
      {
        UpdateExpression: 'ADD #n :one',
        ExpressionAttributeNames: { '#n': name },
        ExpressionAttributeValues: { ':one': 1 }
      }
    );
  }
  async tallies() {
    return Object.fromEntries(
      (
        await this.rows(
          { FilterExpression: 'begins_with(pk, :t)', ExpressionAttributeValues: { ':t': 'TALLY#' } },
          true
        )
      ).map((i) => [
        String(i.pk).split('#')[1],
        Object.fromEntries(
          Object.entries(i)
            .filter(([k]) => !['pk', 'sk'].includes(k))
            .map(([k, v]) => [k, Number(v)])
        )
      ])
    );
  }
  private async listSession(hash: string, user: string, expires: number) {
    await this.put({ ...key(user, `SESSION#${hash}`), expires_at: expires });
  }
  private profileProof(user: string): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: key(user, 'PROFILE'),
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'
      }
    };
  }
  private async provedTransaction(
    TransactItems: NonNullable<TransactWriteCommandInput['TransactItems']>
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++)
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems }));
        return true;
      } catch (e) {
        if ((e as { name?: string })?.name !== 'TransactionCanceledException') throw e;
        if (reasons(e).some((r) => r.Code === 'ConditionalCheckFailed')) return false;
        if (reasons(e).some((r) => r.Code === 'TransactionConflict') && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    throw new Error('Proof transaction retries exhausted');
  }
  async createSession(hash: string, options: SessionInput): Promise<boolean> {
    const { user_id, email, now, expires } = options;
    return this.provedTransaction([
      ...(user_id ? [this.profileProof(user_id)] : []),
      {
        Put: {
          TableName: this.tableName,
          Item: {
            pk: `SESSION#${hash}`,
            sk: 'SESSION',
            created_at: now,
            seen_at: now,
            expires_at: expires,
            ...(user_id ? { user_id } : { email })
          },
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      },
      ...(user_id
        ? [{ Put: { TableName: this.tableName, Item: { ...key(user_id, `SESSION#${hash}`), expires_at: expires } } }]
        : [])
    ]);
  }
  async renewSession(hash: string, user: string | null, now: number, expires: number): Promise<boolean> {
    return this.provedTransaction([
      ...(user ? [this.profileProof(user)] : []),
      {
        Update: {
          TableName: this.tableName,
          Key: { pk: `SESSION#${hash}`, sk: 'SESSION' },
          UpdateExpression: 'SET seen_at = :now, expires_at = :exp',
          ConditionExpression:
            'attribute_exists(pk) AND expires_at > :now AND ' +
            (user ? 'user_id = :u' : 'attribute_not_exists(user_id)'),
          ExpressionAttributeValues: { ':now': now, ':exp': expires, ...(user ? { ':u': user } : {}) }
        }
      },
      ...(user
        ? [{ Put: { TableName: this.tableName, Item: { ...key(user, `SESSION#${hash}`), expires_at: expires } } }]
        : [])
    ]);
  }
  async claimVerifiedSession(
    hash: string,
    user: string,
    email: string,
    now: number,
    expires: number
  ): Promise<boolean> {
    return this.provedTransaction([
      this.profileProof(user),
      {
        Update: {
          TableName: this.tableName,
          Key: { pk: `SESSION#${hash}`, sk: 'SESSION' },
          UpdateExpression: 'SET user_id = :u, seen_at = :now, expires_at = :exp REMOVE email',
          ConditionExpression:
            'attribute_exists(pk) AND expires_at > :now AND (user_id = :u OR (attribute_not_exists(user_id) AND email = :e))',
          ExpressionAttributeValues: { ':u': user, ':e': email, ':now': now, ':exp': expires }
        }
      },
      { Put: { TableName: this.tableName, Item: { ...key(user, `SESSION#${hash}`), expires_at: expires } } }
    ]);
  }
  async putSession(hash: string, options: SessionInput) {
    const { user_id, email, now, expires } = options;
    await this.put({
      pk: `SESSION#${hash}`,
      sk: 'SESSION',
      created_at: now,
      seen_at: now,
      expires_at: expires,
      ...(user_id ? { user_id } : { email })
    });
    if (user_id) await this.listSession(hash, user_id, expires);
  }
  async getSession(hash: string, consistent = false) {
    return this.get({ pk: `SESSION#${hash}`, sk: 'SESSION' }, { ConsistentRead: consistent });
  }
  async touchSession(hash: string, now: number, expires: number, user: string | null = null) {
    await this.update(
      { pk: `SESSION#${hash}`, sk: 'SESSION' },
      {
        UpdateExpression: 'SET seen_at = :now, expires_at = :exp',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':now': now, ':exp': expires }
      }
    );
    if (user) await this.listSession(hash, user, expires);
  }
  async claimSession(hash: string, user: string, expires: number) {
    await this.update(
      { pk: `SESSION#${hash}`, sk: 'SESSION' },
      {
        UpdateExpression: 'SET user_id = :u REMOVE email',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':u': user }
      }
    );
    await this.listSession(hash, user, expires);
  }
  async deleteSession(hash: string) {
    await this.del({ pk: `SESSION#${hash}`, sk: 'SESSION' });
  }
  async mcpGet(pk: string, sk = 'STATE') {
    return this.get({ pk, sk }, { ConsistentRead: true });
  }
  async mcpRows(pk: string) {
    return this.rows({
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': pk },
      ConsistentRead: true
    });
  }
  async mcpProfile(user: string) {
    return this.mcpGet(`USER#${user}`, 'PROFILE');
  }
  async mcpCommit(changes: [Item, number | null][], user: string | null = null) {
    const ops: NonNullable<TransactWriteCommandInput['TransactItems']> = [];
    if (user)
      ops.push({
        ConditionCheck: {
          TableName: this.tableName,
          Key: key(user, 'PROFILE'),
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'
        }
      });
    for (const [row, revision] of changes)
      ops.push(
        this.putOperation(
          { ...row, revision: (revision ?? 0) + 1 },
          revision == null
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : {
                ConditionExpression: '#r = :r',
                ExpressionAttributeNames: { '#r': 'revision' },
                ExpressionAttributeValues: { ':r': revision }
              }
        )
      );
    return this.transact(ops);
  }
  async captureCommit(
    note: Item,
    old: Item | null,
    receipt: Item,
    audit: Item,
    rate: Item,
    previous: Item | null,
    family: Item,
    now: number
  ) {
    const ops: NonNullable<TransactWriteCommandInput['TransactItems']> = this.agentProof(family, now, 'notes:write');
    if (old) {
      const values: Item = {
        ':author': 'assistant',
        ':connection': family.id,
        ':old': old.text ?? '',
        ':revision': old.revision,
        ':text': note.text,
        ':tags': note.tags,
        ':links': note.links,
        ':updated_at': note.updated_at,
        ':next': note.revision
      };
      if (old.updated_at) values[':edited'] = old.updated_at;
      ops.push({
        Update: {
          TableName: this.tableName,
          Key: { pk: String(note.pk), sk: String(note.sk) },
          UpdateExpression: 'SET #t = :text, tags = :tags, links = :links, updated_at = :updated_at, #r = :next',
          ConditionExpression:
            'author = :author AND #c = :connection AND #t = :old AND #r = :revision AND ' +
            (old.updated_at ? 'updated_at = :edited' : 'attribute_not_exists(updated_at)'),
          ExpressionAttributeNames: { '#t': 'text', '#r': 'revision', '#c': 'connection' },
          ExpressionAttributeValues: values
        }
      });
    } else ops.push(this.putOperation(note, { ConditionExpression: 'attribute_not_exists(pk)' }));
    ops.push(...this.agentReceipts(receipt, audit, rate, previous, now));
    return this.transact(ops);
  }
  /** An agent write proves the live account and the family's revision, expiry
   * and the scope it needs, in the same transaction as what it writes. */
  agentProof(family: Item, now: number, scope: string): NonNullable<TransactWriteCommandInput['TransactItems']> {
    return [this.profileProof(String(family.user_id)), ...this.familyProof(family, now, scope)];
  }
  /** The family check alone, for a transaction that already touches PROFILE
   * (DynamoDB refuses two operations on one key). */
  familyProof(family: Item, now: number, scope: string): NonNullable<TransactWriteCommandInput['TransactItems']> {
    return [
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: { pk: `OAUTHFAMILY#${family.id}`, sk: 'STATE' },
          ConditionExpression:
            '#r = :revision AND expires_at > :now AND attribute_not_exists(revoked) AND contains(#s, :write)',
          ExpressionAttributeNames: { '#r': 'revision', '#s': 'scope' },
          ExpressionAttributeValues: { ':revision': family.revision, ':now': now, ':write': scope }
        }
      }
    ];
  }
  /** The 24-hour idempotency receipt, the content-free audit row and the daily
   * write count, each guarded so a retry or a race commits at most once. */
  agentReceipts(
    receipt: Item,
    audit: Item,
    rate: Item,
    previous: Item | null,
    now: number
  ): NonNullable<TransactWriteCommandInput['TransactItems']> {
    return [
      this.putOperation(receipt, {
        ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
        ExpressionAttributeValues: { ':now': now }
      }),
      this.putOperation(audit, { ConditionExpression: 'attribute_not_exists(pk)' }),
      this.putOperation(
        rate,
        previous
          ? {
              ConditionExpression: '#r = :r',
              ExpressionAttributeNames: { '#r': 'revision' },
              ExpressionAttributeValues: { ':r': previous.revision }
            }
          : { ConditionExpression: 'attribute_not_exists(pk)' }
      )
    ];
  }
  async mcpBlock(user: string) {
    await this.update(key(user, 'PROFILE'), {
      UpdateExpression: 'SET mcp_deleting = :yes',
      ExpressionAttributeValues: { ':yes': true },
      ConditionExpression: 'attribute_exists(pk)'
    });
  }
}
