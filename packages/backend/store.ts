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
 * PROFILE.giving maps a calendar year ("2026") to `{first, last}`, the local
 * days a Weekly Thing lookup saw a Supporting Member (domain/giving.ts):
 * only ever widened, one conditional step at a time (`widenGiving`), gone
 * with the profile.
 * PROFILE.photo is the profile photo (profile-photo.ts): `{key, at, size,
 * side}`, its file at media/<owner>/profile/<id>.jpg. Set, replaced
 * (`setPhoto`) and removed (`dropPhoto`) only while it still names the
 * photo read; the key is never answered, and it goes with the profile.
 * USER#<owner> / BOOK is the PDF book's build (packages/book), as EXPORT is
 * the zip's: the span asked for (`from`, `to`, `title`), and once made its
 * file under exports/ (`export_key`), size, pages and photos, offered for a
 * day, with `commentary` and `release` (an age) when it asked for Claude's.
 * One at a time; deleted with the account like the zip.
 * USER#<owner> / COMMENTARY#<age> counts in `made` the finished books with
 * Claude's commentary asked for in that release (packages/book/limits.ts),
 * ADDed in the transaction that finishes the book; deleted with the account.
 * USER#<owner> / BADGES holds `seen`, a string set of the badges (`id` or
 * `id:tier`) already celebrated, so the email names each once
 * (docs/BADGES.md), and `eggs`, the easter eggs found (domain/eggs.ts),
 * each ADDed only if absent in the transaction that writes its one
 * `egg.found` row, so two pages finding it at once write one. Only ever
 * ADDed to, with the account proof; deleted with the account and never
 * exported.
 * USER#<owner> / ACTIVITY#<ISO time>#<kind>#<id> is the activity log
 * (`domain/activity.ts`, docs/WEB-APP.md): one row for each thing that
 * happened to the account, kept for its life, in the export, shown only to
 * its owner and their agents, and deleted with the account. Each row is
 * written with the account proof. A mail row (ACTIVITY#<received ISO>#mail#<SES
 * message id>) says what became of an email that reached the owner's address
 * (outcome, reason, sender, subject, and the text only for a sender already
 * proven); notified_at marks its one problem notice, and
 * RATE#mailnotice:<owner>#<UTC day> caps those at three a day.
 * MCPMETA#<owner> / ACTIVITY#<local day's first instant>#reads#<connection>
 * sums one assistant's reads that day, written by the MCP reader with the
 * account proof and a revision, deleted with the account's MCP rows.
 * USER#<owner> / FEEDBACK#<id> is one item of feedback (domain/feedback.ts):
 * `kind`, `text`, `follows` (an earlier item's id or null), `via` (web or
 * assistant) with `client`/`connection` for an assistant, `filed_at`,
 * `status`, `answers` (append-only `{at, text, status}`), `screenshots`
 * (`{n, type, size, width, height, key}`, files under media/<owner>/feedback/,
 * never shown by key), `revision` and `updated_at`. Never edited by its
 * filer; answered only by the administrator; in the export, gone with the
 * account. The administrator's queue reads every account's rows (userIds,
 * then one Query each), so there is no shared index to keep.
 * USER#<owner> / FEEDBACKRATE#<UTC day> counts in `n` the items filed that
 * day from every door, ADDed in the filing transaction under FEEDBACK_A_DAY,
 * with expires_at two days on; deleted with the account.
 * USER#<owner> / APITOKEN#<id> is an API token (tokens.ts, docs/API.md):
 * `id`, `name`, `scope`, `created_at`, `expires_at` (absent when it never
 * expires), `hash` (its SHA-256, never the value), `revoked` once its own
 * client signed out, and `revision`, which each token write proves. Its
 * hash points back from OAUTHACCESS#<hash> / STATE (`kind` token, `user_id`,
 * `token`, `resource` <origin>/v1), tracked under OAUTHUSER# ROW#, so the
 * OAuth deletion removes it; never exported. Once the token ends the
 * pointer stays 30 days with `revoked`, so its client is told so. A token's note is
 * NOTE#<day>#t-<id> (`source` api, `connection` the token's id, `token` its
 * name, `client` the User-Agent's product), its receipts
 * CAPTURE#<token id>#<key hash> for 7 days, its daily counts
 * MCPMETA#<owner> / WRITERATE#v1-create# and WRITERATE#v1-change#<UTC day>
 * for the account, and its reads MCPMETA#<owner> / TOKENREADS#<id>#<UTC day>.
 * PROFILE.pinned_tags is the pinned tags (up to 12, normalized as hashtags),
 * the same on the web and through every token.
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
import { ACTIVITY, ACTIVITY_END } from '../domain/activity.ts';
import {
  feedbackItem,
  feedbackKey,
  feedbackRateKey,
  FEEDBACK_A_DAY,
  type FeedbackAnswer,
  type FeedbackItem
} from '../domain/feedback.ts';
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
/** How long a revoked token's pointer answers `token_revoked`. */
export const TOKEN_TOMBSTONE_SECONDS = 30 * 86400;
import { writtenAt as written } from '../domain/notes.ts';
import { givingYears, type GivingYear } from '../domain/giving.ts';
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export type ExportSlot = 'EXPORT' | 'BOOK';
type Ops = NonNullable<TransactWriteCommandInput['TransactItems']>;
/** Sets `fields` on a build's row while it is still that build, building. */
function finishing(id: string, fields: Item) {
  const entries = Object.entries(fields);
  return {
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
  };
}
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
  /** An account's feedback, oldest first (packages/domain/feedback.ts). */
  async feedbackItems(user: string): Promise<FeedbackItem[]> {
    return (
      await this.rows({
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        ExpressionAttributeValues: { ':p': `USER#${user}`, ':s': 'FEEDBACK#' },
        ConsistentRead: true
      })
    ).map(feedbackItem);
  }
  async feedbackItem(user: string, id: string): Promise<FeedbackItem | null> {
    const row = await this.get(key(user, feedbackKey(id)), { ConsistentRead: true });
    return row ? feedbackItem(row) : null;
  }
  async feedbackFiled(user: string, day: string): Promise<number> {
    return Number((await this.get(key(user, feedbackRateKey(day)), { ConsistentRead: true }))?.n ?? 0);
  }
  /** Files one item: the row (never there before), the item it follows (still
   * there), the UTC day's count (under FEEDBACK_A_DAY) and the live account,
   * together. `proofs` replaces the account proof for an agent, whose proof
   * also names its grant. False when a condition failed; nothing is written. */
  async fileFeedback(user: string, item: FeedbackItem, day: string, proofs: Ops | null = null): Promise<boolean> {
    const ops: Ops = [
      this.putOperation(
        { ...key(user, feedbackKey(item.id)), ...item },
        { ConditionExpression: 'attribute_not_exists(pk)' }
      ),
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, feedbackRateKey(day)),
          UpdateExpression: 'ADD #n :one SET expires_at = :expires',
          ConditionExpression: 'attribute_not_exists(#n) OR #n < :cap',
          ExpressionAttributeNames: { '#n': 'n' },
          ExpressionAttributeValues: {
            ':one': 1,
            ':cap': FEEDBACK_A_DAY,
            ':expires': Math.floor(Date.parse(day + 'T00:00:00Z') / 1000) + 2 * 86400
          }
        }
      },
      ...(proofs ?? [this.profileProof(user)])
    ];
    if (item.follows)
      ops.push({
        ConditionCheck: {
          TableName: this.tableName,
          Key: key(user, feedbackKey(item.follows)),
          ConditionExpression: 'attribute_exists(pk)'
        }
      });
    return this.provedTransaction(ops);
  }
  /** Adds one answer to an item still at `revision`, and the status it set.
   * Answers are only ever appended. `admin` (the web's administrator) proves
   * that account is still the configured one, as product updates do; an
   * operator tool, with no session, passes none. */
  async answerFeedback(
    owner: string,
    id: string,
    revision: number,
    answer: FeedbackAnswer,
    admin: { user: string; email: string } | null = null
  ): Promise<boolean> {
    const ops: Ops = [
      {
        Update: {
          TableName: this.tableName,
          Key: key(owner, feedbackKey(id)),
          UpdateExpression:
            'SET #a = list_append(if_not_exists(#a, :none), :answer), #s = :status, #u = :at, #r = :next',
          ConditionExpression: 'attribute_exists(pk) AND #r = :revision',
          ExpressionAttributeNames: { '#a': 'answers', '#s': 'status', '#u': 'updated_at', '#r': 'revision' },
          ExpressionAttributeValues: {
            ':none': [],
            ':answer': [answer],
            ':status': answer.status,
            ':at': answer.at,
            ':next': revision + 1,
            ':revision': revision
          }
        }
      }
    ];
    if (admin)
      ops.push({
        ConditionCheck: {
          TableName: this.tableName,
          Key: key(admin.user, 'PROFILE'),
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND email = :admin',
          ExpressionAttributeValues: { ':admin': admin.email }
        }
      });
    return this.provedTransaction(ops);
  }
  /** Every account's id, address and state, for the administrator's feedback
   * queue: a metadata scan inside the same IAM attribute limit as the
   * overview below, so it reads no journal contents. */
  async accountStates(): Promise<{ owner: string; email: string | null; status: string; deleting: boolean }[]> {
    return (
      await this.rows(
        {
          Select: 'SPECIFIC_ATTRIBUTES',
          FilterExpression: 'begins_with(pk, :u) AND sk = :p',
          ProjectionExpression: 'pk, email, #st, mcp_deleting',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':u': 'USER#', ':p': 'PROFILE' }
        },
        true
      )
    )
      .map((i) => ({
        owner: String(i.pk).slice(5),
        email: i.email ? String(i.email) : null,
        status: String(i.status ?? 'active'),
        deleting: Boolean(i.mcp_deleting)
      }))
      .sort((a, b) => compare(a.owner, b.owner));
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
          ConditionExpression:
            'attribute_exists(pk) AND attribute_not_exists(#p) AND attribute_not_exists(place_cleared)' +
            sourceCondition,
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
  /** The profile photo (profile-photo.ts): set only while PROFILE still holds
   * the photo the caller read (`old`, its key, or none), so two tabs racing
   * never leave an object nothing points at unremoved. False when another
   * change got there first. */
  async setPhoto(user: string, photo: Item, old: string | null): Promise<boolean> {
    return this.conditional(() =>
      this.update(key(user, 'PROFILE'), {
        UpdateExpression: 'SET #photo = :photo',
        ConditionExpression: old
          ? 'attribute_exists(pk) AND #photo.#key = :old'
          : 'attribute_exists(pk) AND attribute_not_exists(#photo)',
        ExpressionAttributeNames: old ? { '#photo': 'photo', '#key': 'key' } : { '#photo': 'photo' },
        ExpressionAttributeValues: old ? { ':photo': photo, ':old': old } : { ':photo': photo }
      })
    );
  }
  /** Removes the profile photo while it is still the one read (`old`, its key). */
  async dropPhoto(user: string, old: string): Promise<boolean> {
    return this.conditional(() =>
      this.update(key(user, 'PROFILE'), {
        UpdateExpression: 'REMOVE #photo',
        ConditionExpression: 'attribute_exists(pk) AND #photo.#key = :old',
        ExpressionAttributeNames: { '#photo': 'photo', '#key': 'key' },
        ExpressionAttributeValues: { ':old': old }
      })
    );
  }
  /** A Weekly Thing lookup on local `day` answered `member`: the day's year
   * added to PROFILE.giving, or its first or last day moved out to `day`.
   * Each step is its own conditional write, so two lookups at once (the
   * sender's and a visit's) only ever widen it and never put back an older
   * map. `seen` is the giving read with the profile: what it already covers
   * can only have widened since, so needs no write. A step refused because
   * another lookup got there first is read again and passed; any other
   * refusal (a gone profile, the web guard's proofs) is thrown. True when
   * this call is the one that added the year. */
  async widenGiving(user: string, day: string, seen: unknown): Promise<boolean> {
    const Key = key(user, 'PROFILE'),
      year = day.slice(0, 4),
      names = { '#g': 'giving', '#y': year },
      known = (value: unknown) => givingYears(value).find((g) => String(g.year) === year);
    let had = known(seen);
    // The web guard (guarded-store.ts) merges its proofs into a PROFILE
    // write, so it reports this step's refusal as a cancelled transaction.
    const step = async (
      input: Omit<UpdateCommandInput, 'TableName' | 'Key'>,
      done: (now: GivingYear | undefined) => boolean
    ) => {
      try {
        await this.update(Key, input);
        return true;
      } catch (e) {
        if (!conditionFailed(e) && !(e instanceof Error && e.name === 'TransactionCanceledException')) throw e;
        const now = known((await this.profile(user, true))?.giving);
        if (!done(now)) throw e;
        had = now;
        return false;
      }
    };
    if (!had) {
      if (!seen || typeof seen !== 'object')
        await this.update(Key, {
          UpdateExpression: 'SET #g = if_not_exists(#g, :empty)',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: { '#g': 'giving' },
          ExpressionAttributeValues: { ':empty': {} }
        });
      const added = await step(
        {
          UpdateExpression: 'SET #g.#y = :span',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#g.#y)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ':span': { first: day, last: day } }
        },
        (now) => !!now
      );
      if (added) return true;
    }
    for (const end of ['first', 'last'] as const) {
      const beyond = (g: GivingYear) => (end === 'first' ? g.first > day : g.last < day);
      if (!had || beyond(had))
        await step(
          {
            UpdateExpression: 'SET #g.#y.#e = :d',
            ConditionExpression: `#g.#y.#e ${end === 'first' ? '>' : '<'} :d`,
            ExpressionAttributeNames: { ...names, '#e': end },
            ExpressionAttributeValues: { ':d': day }
          },
          (now) => !!now && !beyond(now)
        );
    }
    return false;
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
    if (!/^ACTIVITY#[^#]+#mail#/.test(sk)) throw new RangeError('Not a mail row');
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
  /** The activity rows badges read (docs/BADGES.md, the firsts earned
   * outside notes): photo.set, export.book, upcoming.added, egg.found (an
   * easter egg, domain/eggs.ts), and note.edited by an assistant, oldest
   * first, with only the fields they need. */
  async badgeActivity(user: string, consistent = false): Promise<Item[]> {
    return this.rows({
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      FilterExpression: '#k = :photo OR #k = :book OR #k = :added OR #k = :egg OR (#k = :edited AND #v = :assistant)',
      ProjectionExpression: 'sk, #k, #a, #v, #u, #e',
      ExpressionAttributeNames: { '#k': 'kind', '#a': 'at', '#v': 'via', '#u': 'upcoming', '#e': 'egg' },
      ExpressionAttributeValues: {
        ':p': `USER#${user}`,
        ':s': ACTIVITY,
        ':photo': 'photo.set',
        ':book': 'export.book',
        ':added': 'upcoming.added',
        ':egg': 'egg.found',
        ':edited': 'note.edited',
        ':assistant': 'assistant'
      },
      ...(consistent ? { ConsistentRead: true } : {})
    });
  }
  /** One page of the activity log, newest first: the rows below `before` (a
   * row's id, or an ISO time) and from `from` (an ISO time) on, merged from
   * the account's rows and its assistants' daily reads. `more` says older
   * rows remain. */
  async activity(
    user: string,
    o: { before?: string; from?: string; limit: number }
  ): Promise<{ rows: Item[]; more: boolean }> {
    const lo = ACTIVITY + (o.from ?? ''),
      hi = o.before ? ACTIVITY + o.before : ACTIVITY_END,
      within = (i: Item) => String(i.sk) >= lo && String(i.sk) < hi,
      // One more than a page, and one for the row at `before` itself; a
      // response stops at 1 MB, so read on until there are that many.
      range = async (pk: string) => {
        const items: Item[] = [];
        let cursor: Key | undefined;
        do {
          const result = await this.client.send(
            new QueryCommand({
              TableName: this.tableName,
              KeyConditionExpression: 'pk = :p AND sk BETWEEN :lo AND :hi',
              ExpressionAttributeValues: { ':p': pk, ':lo': lo, ':hi': hi },
              ScanIndexForward: false,
              Limit: o.limit + 2 - items.length,
              ...(cursor ? { ExclusiveStartKey: cursor } : {})
            })
          );
          items.push(...(result.Items ?? []));
          cursor = result.LastEvaluatedKey;
        } while (cursor && items.length < o.limit + 2);
        return items;
      },
      [own, reads] = await Promise.all([range(`USER#${user}`), range(`MCPMETA#${user}`)]),
      merged = new Map<string, Item>();
    for (const row of [...reads, ...own]) if (within(row)) merged.set(String(row.sk), row);
    const rows = [...merged.values()].sort((a, b) => compare(String(b.sk), String(a.sk)));
    return { rows: rows.slice(0, o.limit), more: rows.length > o.limit };
  }
  /** Activity rows (packages/backend/activity.ts), each transaction with the
   * account proof, 90 rows at most: false once one fails. */
  async putActivity(user: string, rows: readonly Item[]): Promise<boolean> {
    for (let start = 0; start < rows.length; start += 90)
      if (
        !(await this.provedTransaction([
          this.profileProof(user),
          ...rows
            .slice(start, start + 90)
            .map((row) => this.putOperation(row, { ConditionExpression: 'attribute_not_exists(pk)' }))
        ]))
      )
        return false;
    return true;
  }
  /** Every activity row from `from` (an ISO time) on, newest first. */
  async activityAll(user: string, from?: string): Promise<Item[]> {
    const all: Item[] = [];
    for (let before: string | undefined; ;) {
      const page = await this.activity(user, { before, from, limit: 500 });
      all.push(...page.rows);
      if (!page.more) return all;
      before = String(page.rows.at(-1)!.sk).slice(ACTIVITY.length);
    }
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
  /** An easter egg found: `egg` ADDed to BADGES' `eggs` only if absent,
   * with `rows` (its `egg.found` row and any badge rows) and the account
   * proof, all or nothing. False when it was found before, or the account
   * is gone or going. */
  async findEgg(user: string, egg: string, rows: readonly Item[], at: string): Promise<boolean> {
    return this.provedTransaction([
      this.profileProof(user),
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, 'BADGES'),
          UpdateExpression: 'ADD eggs :e SET updated_at = :t',
          ConditionExpression: 'attribute_not_exists(eggs) OR NOT contains(eggs, :egg)',
          ExpressionAttributeValues: { ':e': new Set([egg]), ':egg': egg, ':t': at }
        }
      },
      ...rows.map((row) => this.putOperation(row, { ConditionExpression: 'attribute_not_exists(pk)' }))
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
  /** The owner's own change to where a note was. Clearing it (null) marks
   * `place_cleared`, so a photo's spot never fills it in again. */
  async changeNotePlace(user: string, day: string, id: string, place: Item | null) {
    try {
      return (
        (
          await this.update(key(user, `NOTE#${day}#${id}`), {
            UpdateExpression: place ? 'SET #p = :p REMOVE place_cleared' : 'SET place_cleared = :p REMOVE #p',
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeNames: { '#p': 'place' },
            ExpressionAttributeValues: { ':p': place ?? true },
            ReturnValues: 'ALL_NEW'
          })
        ).Attributes ?? null
      );
    } catch (e) {
      if (conditionFailed(e)) return null;
      throw e;
    }
  }
  /** The zip export (EXPORT) or the PDF book (BOOK): one build of each at a
   * time, the newer start replacing the older, each finished only by the
   * build that started it. */
  async export(user: string, slot: ExportSlot = 'EXPORT') {
    return this.get(key(user, slot));
  }
  async startExport(
    user: string,
    id: string,
    now: number,
    expires: number,
    slot: ExportSlot = 'EXPORT',
    fields: Item = {}
  ) {
    await this.put({ ...fields, ...key(user, slot), id, status: 'building', started_at: now, expires_at: expires });
  }
  /** `counted`: a finished book with commentary, counted against that
   * release (age) in the same write. */
  async finishExportGuarded(
    user: string,
    id: string,
    fields: Item,
    slot: ExportSlot = 'EXPORT',
    counted?: number
  ): Promise<boolean> {
    return this.provedTransaction([
      this.profileProof(user),
      { Update: { TableName: this.tableName, Key: key(user, slot), ...finishing(id, fields) } },
      ...(counted === undefined
        ? []
        : [
            {
              Update: {
                TableName: this.tableName,
                Key: key(user, `COMMENTARY#${counted}`),
                UpdateExpression: 'ADD #m :one',
                ExpressionAttributeNames: { '#m': 'made' },
                ExpressionAttributeValues: { ':one': 1 }
              }
            }
          ])
    ]);
  }
  /** How many finished books with commentary a release (age) has had. Read
   * strongly: this is the only check of the ceiling, and a book asked for as
   * soon as the tenth finishes must see ten. */
  async commentaryMade(user: string, release: number): Promise<number> {
    return Number((await this.get(key(user, `COMMENTARY#${release}`), { ConsistentRead: true }))?.made ?? 0);
  }
  async finishExport(user: string, id: string, fields: Item, slot: ExportSlot = 'EXPORT') {
    return this.conditional(() => this.update(key(user, slot), finishing(id, fields)));
  }
  async userItems(user: string) {
    return this.rows({ KeyConditionExpression: 'pk = :u', ExpressionAttributeValues: { ':u': `USER#${user}` } });
  }
  /** What an export reads: every USER# row and the assistants' daily reads. */
  async exportItems(user: string) {
    const [own, reads] = await Promise.all([
      this.userItems(user),
      this.rows({
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :a)',
        ExpressionAttributeValues: { ':p': `MCPMETA#${user}`, ':a': ACTIVITY }
      })
    ]);
    return [...own, ...reads];
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
  /** One more file on the account's uploads a UTC day, the web's and every
   * token's together, while it stays under both caps. */
  private uploadCount(user: string, day: number, size: number, maxFiles: number, maxBytes: number) {
    return {
      Key: { pk: `RATE#upload:${user}#${day}`, sk: 'RATE' },
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
    };
  }
  async countUpload(user: string, day: number, size: number, maxFiles: number, maxBytes: number) {
    const { Key, ...count } = this.uploadCount(user, day, size, maxFiles, maxBytes);
    return this.conditional(() => this.update(Key, count));
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
    now: number,
    added?: readonly Item[]
  ) {
    // Files ride on a note: their write proves media:write as well.
    const files = Boolean(added?.length || (!old && Array.isArray(note.media) && note.media.length)),
      ops: NonNullable<TransactWriteCommandInput['TransactItems']> = this.agentProof(
        family,
        now,
        files ? ['notes:write', 'media:write'] : 'notes:write'
      );
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
      // New files go after the ones the note had when read, as the web's
      // addMedia appends them: a worker's description or transcript written
      // into an existing entry meanwhile is kept, and a file added on the
      // web meanwhile refuses this, to be read again.
      const had = ((old.media as Item[] | undefined) ?? []).length;
      if (added?.length) Object.assign(values, { ':m': added, ':none': [], ':had': had });
      ops.push({
        Update: {
          TableName: this.tableName,
          Key: { pk: String(note.pk), sk: String(note.sk) },
          UpdateExpression:
            'SET #t = :text, tags = :tags, links = :links, updated_at = :updated_at, #r = :next' +
            (added?.length ? ', media = list_append(if_not_exists(media, :none), :m)' : ''),
          ConditionExpression:
            'author = :author AND #c = :connection AND #t = :old AND #r = :revision AND ' +
            (old.updated_at ? 'updated_at = :edited' : 'attribute_not_exists(updated_at)') +
            (added?.length
              ? had
                ? ' AND size(media) = :had'
                : ' AND (attribute_not_exists(media) OR size(media) = :had)'
              : ''),
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
  agentProof(
    family: Item,
    now: number,
    scope: string | readonly string[]
  ): NonNullable<TransactWriteCommandInput['TransactItems']> {
    return [this.profileProof(String(family.user_id)), ...this.familyProof(family, now, scope)];
  }
  /** The family check alone, for a transaction that already touches PROFILE
   * (DynamoDB refuses two operations on one key). */
  familyProof(
    family: Item,
    now: number,
    scope: string | readonly string[]
  ): NonNullable<TransactWriteCommandInput['TransactItems']> {
    // One check on the family row (DynamoDB takes one operation a key), so a
    // second scope is a second contains() in the same condition.
    const [first, ...more] = typeof scope === 'string' ? [scope] : scope;
    return [
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: { pk: `OAUTHFAMILY#${family.id}`, sk: 'STATE' },
          ConditionExpression:
            '#r = :revision AND expires_at > :now AND attribute_not_exists(revoked) AND contains(#s, :write)' +
            more.map((_, i) => ` AND contains(#s, :also${i})`).join(''),
          ExpressionAttributeNames: { '#r': 'revision', '#s': 'scope' },
          ExpressionAttributeValues: {
            ':revision': family.revision,
            ':now': now,
            ':write': first,
            ...Object.fromEntries(more.map((s, i) => [`:also${i}`, s]))
          }
        }
      }
    ];
  }
  /** The 24-hour idempotency receipt and the content-free audit row, for a
   * write whose daily count is kept elsewhere (feedback's FEEDBACKRATE#). */
  agentFiling(receipt: Item, audit: Item, now: number): Ops {
    return [
      this.putOperation(receipt, {
        ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
        ExpressionAttributeValues: { ':now': now }
      }),
      this.putOperation(audit, { ConditionExpression: 'attribute_not_exists(pk)' })
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
      ...this.agentFiling(receipt, audit, now),
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
  /** An account's API tokens (tokens.ts), read strongly. */
  async apiTokens(user: string) {
    return this.rows({
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :t)',
      ExpressionAttributeValues: { ':p': `USER#${user}`, ':t': 'APITOKEN#' },
      ConsistentRead: true
    });
  }
  /** Ends a token for good: its row goes, and its hash's pointer stays 30
   * days marked revoked (with its ownership row, so deleting the account
   * still finds it), so the client hears `token_revoked`, not
   * `token_unknown`. Unconditional: an expired token's pointer may be gone. */
  async dropToken(user: string, id: string, hash: string, now: number) {
    const end = now + TOKEN_TOMBSTONE_SECONDS;
    return this.transact([
      { Delete: { TableName: this.tableName, Key: key(user, `APITOKEN#${id}`) } },
      {
        Update: {
          TableName: this.tableName,
          Key: { pk: `OAUTHACCESS#${hash}`, sk: 'STATE' },
          UpdateExpression: 'SET revoked = :yes, expires_at = :end',
          ExpressionAttributeValues: { ':yes': true, ':end': end }
        }
      },
      {
        Update: {
          TableName: this.tableName,
          Key: { pk: `OAUTHUSER#${user}`, sk: `ROW#OAUTHACCESS#${hash}` },
          UpdateExpression: 'SET target = :target, expires_at = :end',
          ExpressionAttributeValues: { ':target': `OAUTHACCESS#${hash}`, ':end': end }
        }
      }
    ]);
  }
  /** A token write proves the token's revision, expiry and scopes, as
   * familyProof does an agent's; a token that never expires has no expiry. */
  tokenProof(token: Item, now: number, scope: string | readonly string[]): Ops {
    const [first, ...more] = typeof scope === 'string' ? [scope] : scope;
    return [
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: key(String(token.user_id), `APITOKEN#${token.id}`),
          ConditionExpression:
            '#r = :revision AND attribute_not_exists(revoked) AND ' +
            '(attribute_not_exists(expires_at) OR expires_at > :now) AND contains(#s, :scope)' +
            more.map((_, i) => ` AND contains(#s, :also${i})`).join(''),
          ExpressionAttributeNames: { '#r': 'revision', '#s': 'scope' },
          ExpressionAttributeValues: {
            ':revision': token.revision,
            ':now': now,
            ':scope': first,
            ...Object.fromEntries(more.map((s, i) => [`:also${i}`, s]))
          }
        }
      }
    ];
  }
  /** A token's client signs out: the token is refused from its next request,
   * and Settings removes it for good (tokens.ts). */
  async revokeToken(token: Item) {
    return this.transact([
      this.profileProof(String(token.user_id)),
      {
        Update: {
          TableName: this.tableName,
          Key: key(String(token.user_id), `APITOKEN#${token.id}`),
          UpdateExpression: 'SET revoked = :yes, #r = :next',
          ConditionExpression: '#r = :revision AND attribute_not_exists(revoked)',
          ExpressionAttributeNames: { '#r': 'revision' },
          ExpressionAttributeValues: { ':yes': true, ':revision': token.revision, ':next': Number(token.revision) + 1 }
        }
      }
    ]);
  }
  /** A token's note (docs/API.md), as captureCommit is an agent's: the live
   * account and token, the note, the receipt, the audit and the daily count
   * in one transaction. A change goes only to the token's own note, from the
   * words it read. */
  async apiNoteCommit(
    note: Item,
    old: Item | null,
    receipt: Item,
    audit: Item,
    rate: Item,
    previous: Item | null,
    token: Item,
    now: number,
    added?: readonly Item[]
  ) {
    // Files ride on a note: their write proves media:write as well.
    const files = Boolean(added?.length || (!old && Array.isArray(note.media) && note.media.length)),
      ops: Ops = [
        this.profileProof(String(token.user_id)),
        ...this.tokenProof(token, now, files ? ['notes:write', 'media:write'] : 'notes:write')
      ];
    if (old) {
      const values: Item = {
        ':api': 'api',
        ':token': token.id,
        ':old': old.text ?? '',
        ':revision': old.revision,
        ':text': note.text,
        ':tags': note.tags,
        ':links': note.links,
        ':updated_at': note.updated_at,
        ':next': note.revision
      };
      if (old.updated_at) values[':edited'] = old.updated_at;
      // New files go after the ones the note had when read, as an agent's do
      // (captureCommit): a file added on the web meanwhile refuses this.
      const had = ((old.media as Item[] | undefined) ?? []).length;
      if (added?.length) Object.assign(values, { ':m': added, ':none': [], ':had': had });
      ops.push({
        Update: {
          TableName: this.tableName,
          Key: { pk: String(note.pk), sk: String(note.sk) },
          UpdateExpression:
            'SET #t = :text, tags = :tags, links = :links, updated_at = :updated_at, #r = :next' +
            (added?.length ? ', media = list_append(if_not_exists(media, :none), :m)' : ''),
          ConditionExpression:
            '#src = :api AND #c = :token AND #t = :old AND #r = :revision AND ' +
            (old.updated_at ? 'updated_at = :edited' : 'attribute_not_exists(updated_at)') +
            (added?.length
              ? had
                ? ' AND size(media) = :had'
                : ' AND (attribute_not_exists(media) OR size(media) = :had)'
              : ''),
          ExpressionAttributeNames: { '#t': 'text', '#r': 'revision', '#c': 'connection', '#src': 'source' },
          ExpressionAttributeValues: values
        }
      });
    } else ops.push(this.putOperation(note, { ConditionExpression: 'attribute_not_exists(pk)' }));
    ops.push(...this.agentReceipts(receipt, audit, rate, previous, now));
    return this.transact(ops);
  }
  /** A token's signed form (`POST /v1/uploads`): the live account and token
   * with `media:write`, and one more file on the account's daily uploads,
   * counted with the web's. Says what refused it: the count (`limited`), or
   * the account, the token or a race (`retry`, to check the token again). */
  async apiUploadCount(
    token: Item,
    now: number,
    size: number,
    maxFiles: number,
    maxBytes: number
  ): Promise<'ok' | 'limited' | 'retry'> {
    const user = String(token.user_id),
      { Key, ...count } = this.uploadCount(user, Math.floor(now / 86400), size, maxFiles, maxBytes),
      ops: Ops = [
        this.profileProof(user),
        ...this.tokenProof(token, now, ['notes:write', 'media:write']),
        { Update: { TableName: this.tableName, Key, ...count } }
      ];
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: ops }));
      return 'ok';
    } catch (e) {
      if (!conflict(e)) throw e;
      return reasons(e)[ops.length - 1]?.Code === 'ConditionalCheckFailed' ? 'limited' : 'retry';
    }
  }
  /** A token deletes its own note, as it read it, with the same proofs. */
  async apiNoteDelete(
    old: Item,
    receipt: Item,
    audit: Item,
    rate: Item,
    previous: Item | null,
    token: Item,
    now: number
  ) {
    return this.transact([
      this.profileProof(String(token.user_id)),
      ...this.tokenProof(token, now, 'notes:write'),
      {
        Delete: {
          TableName: this.tableName,
          Key: { pk: String(old.pk), sk: String(old.sk) },
          ConditionExpression: '#src = :api AND #c = :token AND #r = :revision',
          ExpressionAttributeNames: { '#r': 'revision', '#c': 'connection', '#src': 'source' },
          ExpressionAttributeValues: { ':api': 'api', ':token': token.id, ':revision': old.revision }
        }
      },
      ...this.agentReceipts(receipt, audit, rate, previous, now)
    ]);
  }
  /** The pinned tags (PROFILE.pinned_tags), from the list read: through a
   * token with its proofs and receipts, or on the web with none. */
  async setPins(user: string, pins: readonly string[], old: readonly string[] | null, extra: Ops = []) {
    return this.transact([
      {
        Update: {
          TableName: this.tableName,
          Key: key(user, 'PROFILE'),
          UpdateExpression: 'SET pinned_tags = :pins',
          ConditionExpression:
            'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND ' +
            (old ? 'pinned_tags = :old' : 'attribute_not_exists(pinned_tags)'),
          ExpressionAttributeValues: { ':pins': [...pins], ...(old ? { ':old': [...old] } : {}) }
        }
      },
      ...extra
    ]);
  }
  /** The tags of the notes on days from `first` through `last`, oldest day
   * first: the recent tags' row. */
  async tagsBetween(user: string, first: string, last: string) {
    return this.notesBetween(user, first, last, {
      ProjectionExpression: 'sk, #g, written_at, received_at',
      ExpressionAttributeNames: { '#g': 'tags' }
    });
  }
}
