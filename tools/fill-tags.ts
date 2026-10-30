/** Tags for notes from before a hashtag in any script was one (2026-10-30:
 * #東京 is 東京). A note's tags are kept with it when it is written, so an
 * older note has none for those. Counts only. Dry run by default; --write
 * adds them with the account proof and the words unchanged since read, and
 * never takes a tag away: a note whose kept tags its words no longer give
 * is counted and left. `--all` runs every subscriber. */
import type { Store } from '../packages/backend/store.ts';
import type { Item } from '../packages/backend/store-types.ts';
import { found } from '../packages/domain/tags.ts';
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
const emptyCounts = () => ({ notes: 0, to_tag: 0, tags_added: 0, left: 0, tagged: 0, changed: 0 });
const keptTags = (item: Item): string[] =>
  item.tags instanceof Set ? [...item.tags].map(String) : Array.isArray(item.tags) ? item.tags.map(String) : [];
export async function fill(store: Store, user: string, write = false) {
  const counts = emptyCounts();
  for (const item of await store.allNotes(user)) {
    counts.notes++;
    const text = String(item.text ?? ''),
      had = keptTags(item),
      tags = found(text),
      added = tags.filter((tag) => !had.includes(tag));
    if (!added.length) continue;
    if (!had.every((tag) => tags.includes(tag))) {
      counts.left++;
      continue;
    }
    counts.to_tag++;
    counts.tags_added += added.length;
    if (!write) continue;
    const saved = await guardedWrite(store, user, {
      Update: {
        TableName: store.tableName,
        Key: { pk: String(item.pk), sk: String(item.sk) },
        UpdateExpression: 'SET #g = :g',
        ConditionExpression:
          'attribute_exists(pk) AND #t = :t AND ' + (Array.isArray(item.tags) ? '#g = :h' : 'attribute_not_exists(#g)'),
        ExpressionAttributeNames: { '#t': 'text', '#g': 'tags' },
        ExpressionAttributeValues: { ':g': tags, ':t': text, ...(Array.isArray(item.tags) ? { ':h': item.tags } : {}) }
      }
    });
    if (saved) counts.tagged++;
    else counts.changed++;
  }
  return { dry_run: !write, ...counts };
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
    for (const k of Object.keys(emptyCounts()) as (keyof ReturnType<typeof emptyCounts>)[]) total[k] += one[k];
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
