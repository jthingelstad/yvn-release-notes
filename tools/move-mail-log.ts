/** Moves the mail log rows from before the activity log (MAILLOG#, 30 days)
 * into it (packages/backend/store.ts, Store.moveMail), without their expiry.
 * Rows already expired are left for the table to remove. Counts only. Dry
 * run by default; --write moves with the account proof, so a repeat is
 * harmless. Once nothing is left to move, the readers' merge of MAILLOG#
 * rows can go. */
import type { Store } from '../packages/backend/store.ts';
import { LEGACY_MAIL } from '../packages/domain/activity.ts';
import { argumentsFor, writing, invoked, launch, runtime, scan, OperatorError } from './operator.ts';
export async function move(store: Store, write = false, now = Date.now() / 1000) {
  const rows = await scan(store, {
      FilterExpression: 'begins_with(sk, :m)',
      ExpressionAttributeValues: { ':m': LEGACY_MAIL }
    }),
    counts = { rows: 0, subscribers: 0, expired: 0, to_move: 0, moved: 0, kept: 0, gone: 0 },
    users = new Set<string>();
  for (const row of rows) {
    counts.rows++;
    users.add(String(row.pk));
    if (Number(row.expires_at ?? 0) <= now) {
      counts.expired++;
      continue;
    }
    counts.to_move++;
    if (write) counts[await store.moveMail(String(row.pk).replace(/^USER#/, ''), row)]++;
  }
  return { dry_run: !write, ...counts, subscribers: users.size };
}
export async function main(args: string[]) {
  const { positionals, values } = argumentsFor(args);
  if (values.help) {
    console.log('tools/move-mail-log.ts [--write|--dry-run] — counts only');
    return;
  }
  if (positionals.length) throw new OperatorError('Usage: tools/move-mail-log.ts [--write]');
  const write = writing(values),
    s = await runtime(write);
  console.log(JSON.stringify(await move(s.store, write)));
}
if (invoked(import.meta.url)) await launch(main);
