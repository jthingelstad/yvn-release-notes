/** The one-time Badges launch (docs/BADGES.md): what every subscriber has
 * already earned goes into `seen`, so the first email with the badge line
 * names only what comes after. Counts only. Dry run by default; --write ADDs
 * with the account proof, so a repeat is harmless. */
import type { Store } from '../packages/backend/store.ts';
import { badges } from '../packages/backend/badges.ts';
import { localDay, iso, validDay, validTimezone } from '../packages/domain/dates.ts';
import { argumentsFor, writing, invoked, launch, runtime, scan, OperatorError } from './operator.ts';
export async function baseline(store: Store, write = false, now = Date.now() / 1000) {
  const profiles = await scan(store, {
      FilterExpression: 'sk = :p',
      ProjectionExpression: 'pk, birthday, tz, city, country, mcp_deleting',
      ExpressionAttributeValues: { ':p': 'PROFILE' }
    }),
    counts = { subscribers: 0, skipped: 0, earning: 0, earned: 0, already_seen: 0, to_add: 0, written: 0, gone: 0 };
  for (const p of profiles) {
    counts.subscribers++;
    const user = String(p.pk).replace(/^USER#/, '');
    if (p.mcp_deleting || !validTimezone(p.tz) || !validDay(p.birthday)) {
      counts.skipped++;
      continue;
    }
    const earned = (await badges(store, user, p, localDay(now, String(p.tz)))).earned.map((e) => e.key),
      seen = await store.seenBadges(user),
      fresh = earned.filter((k) => !seen.has(k));
    if (earned.length) counts.earning++;
    counts.earned += earned.length;
    counts.already_seen += earned.length - fresh.length;
    counts.to_add += fresh.length;
    if (!write || !fresh.length) continue;
    if (await store.addSeenBadges(user, fresh, iso(now))) counts.written++;
    else counts.gone++;
  }
  return { dry_run: !write, ...counts };
}
export async function main(args: string[]) {
  const { positionals, values } = argumentsFor(args);
  if (values.help) {
    console.log('tools/badges-baseline.ts [--write|--dry-run] — counts only');
    return;
  }
  if (positionals.length) throw new OperatorError('Usage: tools/badges-baseline.ts [--write]');
  const write = writing(values),
    s = await runtime(write);
  console.log(JSON.stringify(await baseline(s.store, write)));
}
if (invoked(import.meta.url)) await launch(main);
