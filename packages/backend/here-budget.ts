import type { Store } from './store.ts';
import { V1_LIMITS } from './tokens.ts';

/** Naming a device's spot (Here) is a paid Amazon Location lookup, so an
 * account names V1_LIMITS.here spots a UTC day, the web's Here and
 * POST /v1/places/here together, counted before the lookup (the 2026-11-08
 * security audit: the web's Here had no count, and needed no account). The
 * count is the one row /v1 has kept since 1.3.0, so a day's spots add up
 * across both. Answers how many are left after this one, 'limit' once the
 * day's are spent, or 'busy' when the row kept changing under it;
 * `between` runs before each retry (/v1 checks its token is still live). */
export async function spendHere(
  store: Pick<Store, 'mcpGet' | 'mcpCommit'>,
  uid: string,
  now: number,
  between: () => Promise<void> = async () => undefined
): Promise<number | 'limit' | 'busy'> {
  const day = Math.floor(now / 86400),
    key = `WRITERATE#v1-here#${day}`,
    cap = V1_LIMITS.here;
  for (let attempt = 0; attempt < 5; attempt++) {
    const previous = await store.mcpGet('MCPMETA#' + uid, key),
      count = Number(previous?.n ?? 0);
    if (count >= cap) return 'limit';
    const row = { pk: 'MCPMETA#' + uid, sk: key, n: count + 1, expires_at: (day + 2) * 86400 };
    if (await store.mcpCommit([[row, previous ? Number(previous.revision) : null]], uid)) return cap - count - 1;
    await between();
  }
  return 'busy';
}
