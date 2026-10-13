/** Once-only link titles for old notes. Dry run by default; --write is a manual
 * operator action. Guarded fetch and unchanged text/missing links proof retained. */
import * as links from '../packages/backend/links.ts';
import type { Store } from '../packages/backend/store.ts';
import {
  argumentsFor,
  writing,
  invoked,
  launch,
  runtime,
  subscriber,
  guardedWrite,
  OperatorError
} from './operator.ts';
export async function fill(store: Store, user: string, write = false, fetch: links.TitleFetcher = links.fetchTitle) {
  const notes = await store.allNotes(user),
    counts = { notes: notes.length, with_addresses: 0, already_named: 0, named: 0, no_title: 0, changed: 0 };
  for (const item of notes) {
    const text = String(item.text ?? '');
    if (!links.urls(text).length) continue;
    counts.with_addresses++;
    if ('links' in item) {
      counts.already_named++;
      continue;
    }
    const got = await links.collect(text, { fetch });
    if (!got.length) {
      counts.no_title++;
      continue;
    }
    counts.named++;
    if (!write) continue;
    const saved = await guardedWrite(store, user, {
      Update: {
        TableName: store.tableName,
        Key: { pk: String(item.pk), sk: String(item.sk) },
        UpdateExpression: 'SET links = :l',
        ConditionExpression: 'attribute_exists(pk) AND #t = :t AND attribute_not_exists(links)',
        ExpressionAttributeNames: { '#t': 'text' },
        ExpressionAttributeValues: { ':l': got, ':t': text }
      }
    });
    if (!saved) {
      counts.named--;
      counts.changed++;
    }
  }
  return { dry_run: !write, ...counts };
}
export async function main(args: string[]) {
  const { positionals, values } = argumentsFor(args);
  if (values.help) {
    console.log('tools/fill-link-titles.ts EMAIL [--write|--dry-run] — counts only');
    return;
  }
  if (positionals.length !== 1) throw new OperatorError('Usage: tools/fill-link-titles.ts EMAIL [--write]');
  const write = writing(values),
    s = await runtime(write),
    [user] = await subscriber(s.store, positionals[0]!);
  console.log(JSON.stringify(await fill(s.store, user, write)));
}
if (invoked(import.meta.url)) await launch(main);
