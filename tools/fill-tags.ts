/** The tags migration for first-class tags (docs/TAGS.md, "The migration";
 * Jamie, 2026-11-08: "Approved: build first-class tags in Release Notes as
 * proposed, with calls 1 to 8 as recommended"). Counts only, never a tag or
 * a person. Dry run by default; --write, a live run, needs Jamie's go.
 *
 * - A note stored before names gains `tag_names`, each named as its text
 *   types it. A note already named is left as it is.
 * - A hashtag that mixes Latin letters with another script was keyed by its
 *   Latin letters alone (#café-東京 was cafe); it is keyed by every part now
 *   (cafe-東京), so its note's key moves to the new one.
 * - A hashtag the note's kept tags lack gains its tag, as the fill of
 *   2026-10-30 did; a kept tag its text doesn't give stays, named by its key.
 * - An Upcoming date with one `tag` gains `tags` and `tag_names` from it. The
 *   `tag` stays, as every writer still keeps it for one release.
 *
 * Each write is conditional on the words and tags read, with the account
 * proof, so a note or date changed since is counted and left. `--all` runs
 * every subscriber. */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Store } from '../packages/backend/store.ts';
import type { Item } from '../packages/backend/store-types.ts';
import { mergeTags, slug, spans, textTags, type Tag } from '../packages/domain/tags.ts';
import { codePointSlice } from '../packages/domain/unicode.ts';
import {
  argumentsFor,
  writing,
  invoked,
  launch,
  runtime,
  scan,
  subscriber,
  guardedWrite,
  OperatorError
} from './operator.ts';
const emptyCounts = () => ({
  notes: 0,
  named: 0,
  to_write: 0,
  to_name: 0,
  rekeyed: 0,
  tags_added: 0,
  kept_by_key: 0,
  upcoming: 0,
  upcoming_to_list: 0,
  written: 0,
  changed: 0
});
type Counts = ReturnType<typeof emptyCounts>;
const keptTags = (item: Item): string[] =>
  item.tags instanceof Set ? [...item.tags].map(String) : Array.isArray(item.tags) ? item.tags.map(String) : [];
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The key each hashtag had before 2026-11-08, for the tag it has now: the
 * legacy slug where it has a-z letters, which dropped any other script. */
export function legacyKeys(text: string): Map<string, Tag> {
  const out = new Map<string, Tag>(),
    named = new Map(textTags(text).map((t) => [t.key, t]));
  for (const [start, end, key] of spans(text)) {
    const old = slug(codePointSlice(text, start + 1, end)),
      tag = named.get(key);
    if (tag && /[a-z]/.test(old) && old !== key && !out.has(old)) out.set(old, tag);
  }
  return out;
}

/** A note's tags as they should be stored, and what made them so. */
export function noteTarget(item: Item): {
  tags: Tag[];
  named: boolean;
  rekeyed: number;
  added: number;
  byKey: number;
} {
  const text = String(item.text ?? ''),
    had = keptTags(item),
    names = Array.isArray(item.tag_names) ? item.tag_names.map(String) : [];
  if (had.length && names.length === had.length)
    return { tags: had.map((key, i) => ({ key, name: names[i]! })), named: true, rekeyed: 0, added: 0, byKey: 0 };
  const typed = textTags(text),
    moved = legacyKeys(text);
  let rekeyed = 0,
    byKey = 0;
  const kept = had.map((key): Tag => {
    const own = typed.find((t) => t.key === key);
    if (own) return own;
    const now = moved.get(key);
    if (now) {
      rekeyed++;
      return now;
    }
    byKey++;
    return { key, name: key };
  });
  const tags = mergeTags(kept, typed);
  return { tags, named: false, rekeyed, added: tags.length - mergeTags(kept).length, byKey };
}

export async function fill(store: Store, user: string, write = false) {
  const counts = emptyCounts();
  for (const item of await store.allNotes(user)) {
    counts.notes++;
    const target = noteTarget(item);
    if (target.named) {
      counts.named++;
      continue;
    }
    const had = keptTags(item);
    if (!target.tags.length && !had.length) continue;
    counts.to_write++;
    if (target.rekeyed) counts.rekeyed++;
    else if (
      !target.added &&
      same(
        had,
        target.tags.map((t) => t.key)
      )
    )
      counts.to_name++;
    counts.tags_added += target.added;
    counts.kept_by_key += target.byKey;
    if (!write) continue;
    const saved = await guardedWrite(store, user, {
      Update: {
        TableName: store.tableName,
        Key: { pk: String(item.pk), sk: String(item.sk) },
        UpdateExpression: 'SET #g = :g, #n = :n',
        ConditionExpression:
          'attribute_exists(pk) AND #t = :t AND attribute_not_exists(#n) AND ' +
          (item.tags === undefined ? 'attribute_not_exists(#g)' : '#g = :h'),
        ExpressionAttributeNames: { '#t': 'text', '#g': 'tags', '#n': 'tag_names' },
        ExpressionAttributeValues: {
          ':g': target.tags.map((t) => t.key),
          ':n': target.tags.map((t) => t.name),
          ':t': String(item.text ?? ''),
          ...(item.tags === undefined ? {} : { ':h': item.tags })
        }
      }
    });
    if (saved) counts.written++;
    else counts.changed++;
  }
  for (const row of await upcomingRows(store, user)) {
    counts.upcoming++;
    if (row.tags !== undefined || typeof row.tag !== 'string' || !row.tag) continue;
    counts.upcoming_to_list++;
    if (!write) continue;
    const saved = await guardedWrite(store, user, {
      Update: {
        TableName: store.tableName,
        Key: { pk: String(row.pk), sk: String(row.sk) },
        UpdateExpression: 'SET #g = :g, #n = :g',
        ConditionExpression: 'attribute_exists(pk) AND #o = :o AND attribute_not_exists(#g)',
        ExpressionAttributeNames: { '#o': 'tag', '#g': 'tags', '#n': 'tag_names' },
        ExpressionAttributeValues: { ':g': [row.tag], ':o': row.tag }
      }
    });
    if (saved) counts.written++;
    else counts.changed++;
  }
  return { dry_run: !write, ...counts };
}
/** The Upcoming rows as stored, not as read through `upcomingEntry`. */
async function upcomingRows(store: Store, user: string): Promise<Item[]> {
  const rows: Item[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        ExpressionAttributeValues: { ':p': `USER#${user}`, ':s': 'UPCOMING#' },
        ConsistentRead: true,
        ExclusiveStartKey: cursor
      })
    );
    rows.push(...((page.Items ?? []) as Item[]));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return rows;
}
/** Every subscriber's, summed: counts only, never a person. */
export async function fillAll(store: Store, write = false) {
  const profiles = await scan(store, {
      FilterExpression: 'sk = :p',
      ProjectionExpression: 'pk, mcp_deleting',
      ExpressionAttributeValues: { ':p': 'PROFILE' }
    }),
    total = { subscribers: 0, skipped: 0, ...emptyCounts() };
  for (const p of profiles) {
    total.subscribers++;
    if (p.mcp_deleting) {
      total.skipped++;
      continue;
    }
    const one = await fill(store, String(p.pk).replace(/^USER#/, ''), write);
    for (const k of Object.keys(emptyCounts()) as (keyof Counts)[]) total[k] += one[k];
  }
  return { dry_run: !write, ...total };
}
export async function main(args: string[]) {
  const { positionals, values } = argumentsFor(args, { all: { type: 'boolean', default: false } });
  if (values.help) {
    console.log('tools/fill-tags.ts EMAIL|--all [--write|--dry-run] — counts only');
    return;
  }
  const write = writing(values);
  if (values.all) {
    if (positionals.length) throw new OperatorError('Usage: tools/fill-tags.ts --all [--write]');
    const s = await runtime(write);
    console.log(JSON.stringify(await fillAll(s.store, write)));
    return;
  }
  if (positionals.length !== 1) throw new OperatorError('Usage: tools/fill-tags.ts EMAIL|--all [--write]');
  const s = await runtime(write),
    [user] = await subscriber(s.store, positionals[0]!);
  console.log(JSON.stringify(await fill(s.store, user, write)));
}
if (invoked(import.meta.url)) await launch(main);
