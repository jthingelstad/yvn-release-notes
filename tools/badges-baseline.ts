/** The one-time Badges launch (docs/BADGES.md): what every subscriber has
 * already earned goes into `seen`, so the first email with the badge line
 * names only what comes after. Counts only. Dry run by default; --write ADDs
 * with the account proof, so a repeat is harmless. `--only id,id` limits it
 * to those badges, for a later badge that should stay quiet for what was
 * earned before it shipped (2026-10-29, Jamie: "Approved: run the badges
 * baseline for Status code, Found and I'm a teapot before tomorrow's
 * email"); a track's id covers all its tiers. */
import type { Store } from '../packages/backend/store.ts';
import { badges } from '../packages/backend/badges.ts';
import { BADGES, TRACKS } from '../packages/domain/badges.ts';
import { localDay, iso, validDay, validTimezone } from '../packages/domain/dates.ts';
import { argumentsFor, writing, invoked, launch, runtime, scan, OperatorError } from './operator.ts';
export async function baseline(store: Store, write = false, now = Date.now() / 1000, only?: ReadonlySet<string>) {
  const profiles = await scan(store, {
      FilterExpression: 'sk = :p',
      ProjectionExpression: 'pk, birthday, tz, city, country, giving, photo, mcp_deleting',
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
    const earned = (await badges(store, user, p, localDay(now, String(p.tz)))).earned
        .filter((e) => !only || only.has(e.id))
        .map((e) => e.key),
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
  const { positionals, values } = argumentsFor(args, { only: { type: 'string' } });
  if (values.help) {
    console.log('tools/badges-baseline.ts [--only id,id] [--write|--dry-run] — counts only');
    return;
  }
  if (positionals.length) throw new OperatorError('Usage: tools/badges-baseline.ts [--only id,id] [--write]');
  const only = typeof values.only === 'string' ? new Set(values.only.split(',').map((id) => id.trim())) : undefined;
  if (only) {
    const known = new Set([...BADGES.map((b) => b.id), ...TRACKS.map((t) => t.id)]),
      unknown = [...only].filter((id) => !known.has(id));
    if (!only.size || unknown.length) throw new OperatorError(`Unknown badge: ${unknown.join(', ') || '(none)'}`);
  }
  const write = writing(values),
    s = await runtime(write);
  console.log(
    JSON.stringify({ ...(only ? { only: [...only] } : {}), ...(await baseline(s.store, write, undefined, only)) })
  );
}
if (invoked(import.meta.url)) await launch(main);
