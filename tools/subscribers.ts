/** Manual local per-subscriber report. Projects identities and note keys only,
 * never words or tokens. Addresses in returned text must stay on this Mac. */
import { rounded } from '../packages/backend/places.ts';
import { counts } from '../packages/backend/census.ts';
import type { Store, Item } from '../packages/backend/store.ts';
import { codePointLength } from '../packages/domain/unicode.ts';
import { invoked, launch, runtime, scan, OperatorError } from './operator.ts';
export async function report(store: Store, now = Date.now() / 1000): Promise<string> {
  const items = await scan(store, {
    FilterExpression: 'begins_with(pk, :u) AND (sk = :p OR begins_with(sk, :d) OR begins_with(sk, :n))',
    ProjectionExpression:
      'pk, sk, email, #st, stopped_reason, created_at, tz, send_time, last_sent_date, pause_from, pause_through, #src, #m[0].#k',
    ExpressionAttributeNames: { '#st': 'status', '#src': 'source', '#m': 'media', '#k': 'kind' },
    ExpressionAttributeValues: { ':u': 'USER#', ':p': 'PROFILE', ':d': 'DAY#', ':n': 'NOTE#' }
  });
  const by = new Map<string, Item[]>();
  for (const item of items) {
    const key = String(item.pk);
    by.set(key, [...(by.get(key) ?? []), item]);
  }
  const rows: string[][] = [];
  for (const userRows of by.values()) {
    const p = userRows.find((row) => row.sk === 'PROFILE');
    if (!p) continue;
    const c = counts(userRows, now),
      noted = userRows
        .filter((row) => String(row.sk).startsWith('NOTE#'))
        .map((row) => String(row.sk).split('#')[1]!)
        .sort(),
      state = c.Paused ? 'paused' : c.Subscribers ? 'active' : `stopped (${p.stopped_reason ?? '?'})`;
    rows.push([
      String(p.email ?? '?'),
      state + (c.Overdue ? ' OVERDUE' : ''),
      String(p.created_at ?? '').slice(0, 10),
      `${p.send_time ?? '06:00'} ${p.tz ?? '?'}`,
      String(p.last_sent_date ?? '-'),
      noted.at(-1) ?? '-',
      String(c.Notes),
      c.ReplyRate30 === undefined ? '-' : `${rounded(c.ReplyRate30)}%`
    ]);
  }
  rows.sort((a, b) => (a[2]! < b[2]! ? -1 : a[2]! > b[2]! ? 1 : 0));
  const head = ['address', 'state', 'since', 'sends at', 'last email', 'last note', 'notes', 'replied 30d'],
    widths = head.map((_, i) => Math.max(...[head, ...rows].map((row) => codePointLength(row[i]!))));
  return [
    ...[head, ...rows].map((row) =>
      row
        .map((value, i) => value + ' '.repeat(widths[i]! - codePointLength(value)))
        .join('  ')
        .trimEnd()
    ),
    '',
    `${rows.length} subscriber(s)`
  ].join('\n');
}
export async function main(args: string[]) {
  if (args.includes('--help')) {
    console.log('tools/subscribers.ts — local private subscriber rows (read only)');
    return;
  }
  if (args.length) throw new OperatorError('Usage: tools/subscribers.ts');
  const s = await runtime();
  console.log(await report(s.store));
}
if (invoked(import.meta.url)) await launch(main);
