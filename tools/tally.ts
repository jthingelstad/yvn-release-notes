/** Monthly aggregate report: counts only, no people or addresses; read only. */
import type { Store } from '../packages/backend/store.ts';
import { invoked, launch, runtime, OperatorError } from './operator.ts';
export const NAMES = ['signups', 'unsubscribes', 'restarts', 'bounces', 'complaints', 'deletes'];
export async function report(store: Store): Promise<string> {
  const rows = await store.tallies(),
    out = ['month    ' + NAMES.map((n) => n.padStart(12)).join('  ')];
  for (const month of Object.keys(rows).sort())
    out.push(`${month}  ` + NAMES.map((n) => String(rows[month]?.[n] ?? 0).padStart(12)).join('  '));
  if (!Object.keys(rows).length) out.push('(nothing counted yet)');
  return out.join('\n');
}
export async function main(args: string[]) {
  if (args.includes('--help')) {
    console.log('tools/tally.ts — monthly counts (read only)');
    return;
  }
  if (args.length) throw new OperatorError('Usage: tools/tally.ts');
  console.log(await report((await runtime()).store));
}
if (invoked(import.meta.url)) await launch(main);
